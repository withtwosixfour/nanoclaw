import fs from 'fs';
import { createOpenAI } from '@ai-sdk/openai';
import path from 'path';
import {
  streamText,
  stepCountIs,
  extractReasoningMiddleware,
  wrapLanguageModel,
  type ModelMessage,
  type ToolCallPart,
  type ToolResultPart,
} from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { withTracing } from '@posthog/ai';
import { PostHog } from 'posthog-node';

import { AGENTS_DIR, SESSIONS_DIR } from '../config';
import { logger } from '../logger';
import { getInstanceId, getInstanceName } from '../instance.js';
import { Agent } from '../types';
import { createToolRegistry } from './tool-registry';
import { buildAgentSystemPrompt } from './prompt-loader.js';
import {
  getCompactionThreshold,
  getModelConfig,
  isModelConfigured,
  listAvailableModelKeys,
  ModelConfig,
} from './model-config';
import {
  getOrCreateSessionId,
  getSessionTokenCount,
  loadMessages,
  saveMessage,
  replaceSessionMessages,
  saveCompactionOutput,
} from './session-store';
import { truncateOutput } from '../context/truncate';
import { getRouteInfo } from '../router';
import {
  detectAndLoadImages,
  extractImagePathsFromMediaNotes,
} from '../attachments/images';
import { pruneToolOutputs } from '../context/prune';
import { Name } from 'drizzle-orm';

const DEFAULT_MODEL_PROVIDER = 'opencode-zen';
const DEFAULT_MODEL_NAME = 'kimi-k2.5';

const activeCompactions = new Set<string>();

// Initialize PostHog client for AI tracing (if enabled)
let posthogClient: PostHog | null = null;

function getPostHogClient(): PostHog | null {
  if (!process.env.POSTHOG_API_KEY) {
    return null;
  }

  if (!posthogClient) {
    posthogClient = new PostHog(process.env.POSTHOG_API_KEY, {
      ...(process.env.POSTHOG_HOST ? { host: process.env.POSTHOG_HOST } : {}),
    });

    posthogClient.identify({
      distinctId: getInstanceId(),
      properties: {
        $set: { name: getInstanceName() },
      },
    });

    logger.debug('PostHog client initialized for AI tracing');
  }

  return posthogClient;
}

// Graceful shutdown for PostHog - exported for use in main shutdown sequence
// Note: This should be called as part of the main shutdown sequence, not in signal handlers
export async function shutdownPostHog(): Promise<void> {
  if (posthogClient) {
    try {
      await posthogClient.shutdown();
      logger.debug('PostHog client shut down successfully');
    } catch (err) {
      logger.error({ err }, 'Error shutting down PostHog client');
    }
  }
}

// Note: Signal handlers (SIGINT/SIGTERM) and uncaughtException/unhandledRejection
// are handled in src/index.ts to avoid duplicate handlers and race conditions.
// PostHog shutdown is called from the main shutdown sequence in index.ts.

export interface AgentInput {
  prompt: string;
  sessionId?: string;
  agentId: string; // Changed from groupFolder
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  modelProvider?: string;
  modelName?: string;
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  pendingAttachments?: Array<{
    filePath: string;
    caption: string;
  }>;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export interface AgentRuntimeDeps {
  sendMessage: (jid: string, text: string, sender?: string) => Promise<void>;
  getRegisteredAgents: () => Promise<Record<string, Agent>>;
  schedulerDeps: {
    agents: () => Promise<Record<string, Agent>>;
    getSessions: () => Promise<Record<string, string>>;
    runAgent: (input: AgentInput) => Promise<AgentOutput>;
    sendMessage: (jid: string, text: string) => Promise<void>;
  };
}

export interface AgentRuntime {
  run: (input: AgentInput) => Promise<AgentOutput>;
}

interface AgentSecrets {
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  OPENCODE_ZEN_API_KEY?: string;
}

function createModel(
  { provider: configProvider, modelName, isOpenAIResponseFormat }: ModelConfig,
  type?: 'agent' | 'compaction',
) {
  const hasApiKey =
    (process.env.OPENCODE_ZEN_API_KEY ?? process.env.ANTHROPIC_API_KEY) !=
    undefined;

  if (!hasApiKey) {
    throw new Error(
      'No API key available for selected model provider. Please configure either OPENCODE_ZEN_API_KEY or ANTHROPIC_API_KEY in your environment.',
    );
  }

  let baseModel;

  if (configProvider === 'opencode-zen') {
    const apiKey = process.env.OPENCODE_ZEN_API_KEY;

    if (!apiKey) {
      throw new Error(
        'OPENCODE_ZEN_API_KEY is required for opencode-zen provider',
      );
    }

    if (isOpenAIResponseFormat) {
      logger.debug(
        { provider: configProvider, modelName, isOpenAIResponseFormat },
        'Creating openai response format model',
      );

      const provider = createOpenAI({
        apiKey: process.env.OPENCODE_ZEN_API_KEY,
        baseURL: 'https://opencode.ai/zen/v1',
      });

      baseModel = provider.responses(modelName);
    } else {
      logger.debug(
        { provider: configProvider, model: modelName, hasApiKey },
        'Creating OpenAI-compatible model',
      );
      const provider = createOpenAICompatible({
        name: 'opencode-zen',
        baseURL: 'https://opencode.ai/zen/v1',
        ...(apiKey ? { apiKey } : {}),
        includeUsage: true,
      });
      baseModel = provider(modelName);
    }
  } else {
    if (configProvider !== 'anthropic') {
      logger.warn(
        { provider: configProvider, fallback: 'anthropic' },
        `Unknown provider, falling back to anthropic`,
      );
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
    logger.debug(
      {
        provider: 'anthropic',
        model: modelName,
        hasApiKey,
        hasAuthToken: !!authToken,
      },
      'Creating Anthropic model',
    );
    const provider = createAnthropic({
      ...(apiKey ? { apiKey } : {}),
      ...(authToken ? { authToken } : {}),
    });
    baseModel = provider(modelName);
  }

  // Wrap with PostHog tracing if enabled
  const phClient = getPostHogClient();
  if (phClient) {
    logger.debug(
      { provider: configProvider, model: modelName },
      'Wrapping model with PostHog tracing',
    );
    return withTracing(baseModel, phClient, {
      posthogDistinctId: getInstanceId(),
      posthogProperties: {
        type: type ?? 'agent',
        provider: configProvider,
        model: modelName,
      },
    });
  }

  return baseModel;
}

function validateRequestedModel(input: AgentInput): void {
  const hasProvider = !!input.modelProvider;
  const hasModel = !!input.modelName;

  if (hasProvider !== hasModel) {
    throw new Error(
      'Model selection must include both modelProvider and modelName.',
    );
  }

  if (!hasProvider || !hasModel) {
    return;
  }

  const provider = input.modelProvider as string;
  const modelName = input.modelName as string;
  if (isModelConfigured(provider, modelName)) {
    return;
  }

  const available = listAvailableModelKeys().join(', ');
  throw new Error(
    `Invalid model selection: ${provider}:${modelName}. Available models: ${available}`,
  );
}

/**
 * Truncate tool results within a message to prevent context overflow.
 * This is called in-flight when messages come back from the AI SDK.
 */
function truncateToolResultsInMessage(message: ModelMessage): ModelMessage {
  if (message.role !== 'tool' || !Array.isArray(message.content)) {
    return message;
  }

  const truncatedContent = message.content.map((part) => {
    if (isToolResultPart(part) && typeof part.output === 'string') {
      const truncateResult = truncateOutput(part.output, {
        maxLines: 500,
        maxBytes: 100 * 1024, // 100KB
        direction: 'head',
      });

      return {
        ...part,
        output: truncateResult.content,
      } as unknown as ToolResultPart;
    }
    return part;
  });

  return {
    ...message,
    content: truncatedContent,
  } as ModelMessage;
}

type ImagePayloadDiagnostics = {
  promptMediaNotes: number;
  promptInjectedImages: number;
  promptInjectedImageBytes: number;
  historyToolImageParts: number;
  historyToolImageBytes: number;
  historyToolTruncatedMarkers: number;
  malformedImageParts: number;
};

type MessagePayloadDiagnostics = {
  totalMessages: number;
  roleCounts: {
    system: number;
    user: number;
    assistant: number;
    tool: number;
  };
  approxTextChars: number;
  toolResultJsonChars: number;
  largestToolResultChars: number;
  largestToolResultToolName: string | null;
};

function getMessagePayloadDiagnostics(
  messages: ModelMessage[],
): MessagePayloadDiagnostics {
  const roleCounts = {
    system: 0,
    user: 0,
    assistant: 0,
    tool: 0,
  };

  let approxTextChars = 0;
  let toolResultJsonChars = 0;
  let largestToolResultChars = 0;
  let largestToolResultToolName: string | null = null;

  for (const message of messages) {
    if (message.role === 'system') roleCounts.system++;
    if (message.role === 'user') roleCounts.user++;
    if (message.role === 'assistant') roleCounts.assistant++;
    if (message.role === 'tool') roleCounts.tool++;

    const content = message.content;
    if (typeof content === 'string') {
      approxTextChars += content.length;
      continue;
    }

    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (isTextPart(part)) {
        approxTextChars += (part.text ?? '').length;
        continue;
      }

      if (!isToolResultPart(part)) continue;

      try {
        const serialized = JSON.stringify(part.output);
        const size = serialized.length;
        toolResultJsonChars += size;
        if (size > largestToolResultChars) {
          largestToolResultChars = size;
          largestToolResultToolName = part.toolName;
        }
      } catch {
        // ignore serialization failures in diagnostics
      }
    }
  }

  return {
    totalMessages: messages.length,
    roleCounts,
    approxTextChars,
    toolResultJsonChars,
    largestToolResultChars,
    largestToolResultToolName,
  };
}

function getImagePayloadDiagnostics(
  messages: ModelMessage[],
  promptMediaNotes: number,
): ImagePayloadDiagnostics {
  let promptInjectedImages = 0;
  let promptInjectedImageBytes = 0;
  let historyToolImageParts = 0;
  let historyToolImageBytes = 0;
  let historyToolTruncatedMarkers = 0;
  let malformedImageParts = 0;

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;

    if (message.role === 'user') {
      for (const part of message.content) {
        if (
          part &&
          typeof part === 'object' &&
          (part as { type?: unknown }).type === 'image'
        ) {
          const image = (part as { image?: unknown }).image;
          if (typeof image === 'string') {
            promptInjectedImages++;
            promptInjectedImageBytes += image.length;
            if (image.includes('NaN bytes truncated')) {
              malformedImageParts++;
            }
          }
        }
      }
      continue;
    }

    if (message.role !== 'tool') continue;

    for (const part of message.content) {
      if (!isToolResultPart(part)) continue;
      const output = part.output as unknown;
      if (!output || typeof output !== 'object') continue;

      const value = (output as { value?: unknown }).value;
      if (!Array.isArray(value)) continue;

      for (const outputPart of value) {
        if (
          !outputPart ||
          typeof outputPart !== 'object' ||
          (outputPart as { type?: unknown }).type !== 'image-data'
        ) {
          continue;
        }

        const data = (outputPart as { data?: unknown }).data;
        if (typeof data !== 'string') continue;

        historyToolImageParts++;
        historyToolImageBytes += data.length;

        if (data.includes('NaN bytes truncated')) {
          historyToolTruncatedMarkers++;
          malformedImageParts++;
        }

        if (!/^[A-Za-z0-9+/=\r\n]+$/.test(data)) {
          malformedImageParts++;
        }
      }
    }
  }

  return {
    promptMediaNotes,
    promptInjectedImages,
    promptInjectedImageBytes,
    historyToolImageParts,
    historyToolImageBytes,
    historyToolTruncatedMarkers,
    malformedImageParts,
  };
}

async function runQuery(
  prompt: string,
  sessionId: string,
  input: AgentInput,
  deps: AgentRuntimeDeps,
): Promise<{
  newSessionId: string;
  responseText: string;
  usageTokens: number;
  pendingAttachments?: Array<{ filePath: string; caption: string }>;
}> {
  const queryStartTime = Date.now();
  const config = getModelConfig(input.modelProvider, input.modelName);

  logger.info(
    {
      agent: input.agentId,
      sessionId,
      chatJid: input.chatJid,
      provider: config.provider,
      model: config.modelName,
      promptLength: prompt.length,
      isScheduledTask: input.isScheduledTask,
    },
    'Starting model query',
  );

  const model = createModel(config);

  const systemPrompt = buildAgentSystemPrompt(input.agentId, input.isMain);
  const routeInfo = await getRouteInfo(input.chatJid);
  const routeContext = routeInfo
    ? `You are operating in the conversation "${routeInfo.threadId}" with agent "${routeInfo.agentId}".`
    : `You are operating in the conversation "${input.chatJid}" with agent "${input.agentId}".`;
  const messages: ModelMessage[] = [];
  if (systemPrompt) {
    messages.push({
      role: 'system',
      content: `${routeContext}\n\n${systemPrompt}`,
    });
  } else {
    messages.push({ role: 'system', content: routeContext });
  }
  const loadedMessages = await loadMessages(input.chatJid, sessionId);
  messages.push(...loadedMessages);

  // Prepend current datetime to the prompt so model always knows the current time
  const now = new Date().toISOString();
  const promptWithDatetime = `[Current date and time: ${now}]\n\n${prompt}`;

  // Check if model supports vision and inject images if available
  // Reuse existing config from line 256
  let userContent:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image'; image: string; mediaType: string }
      >;

  if (config.supportsVision) {
    const mediaNotes = extractImagePathsFromMediaNotes(prompt);
    const images = await detectAndLoadImages(prompt);

    logger.debug(
      {
        agent: input.agentId,
        sessionId,
        supportsVision: true,
        promptMediaNoteCount: mediaNotes.length,
        loadedImageCount: images.length,
        loadedImageBytes: images.reduce(
          (sum, img) => sum + img.base64.length,
          0,
        ),
        missingImages: Math.max(0, mediaNotes.length - images.length),
      },
      'Vision image load diagnostics',
    );

    if (images.length > 0) {
      userContent = [
        { type: 'text' as const, text: promptWithDatetime },
        ...images.map((img) => ({
          type: 'image' as const,
          image: img.base64,
          mediaType: img.mediaType,
        })),
      ];
    } else {
      userContent = promptWithDatetime;
    }
  } else {
    userContent = promptWithDatetime;
  }

  messages.push({ role: 'user', content: userContent });

  const imageDiagnostics = getImagePayloadDiagnostics(
    messages,
    extractImagePathsFromMediaNotes(prompt).length,
  );
  const messagePayloadDiagnostics = getMessagePayloadDiagnostics(messages);

  logger.debug(
    {
      agent: input.agentId,
      sessionId,
      ...imageDiagnostics,
      ...messagePayloadDiagnostics,
    },
    'Model image context diagnostics',
  );

  logger.debug(
    {
      agent: input.agentId,
      sessionId,
      messageCount: messages.length,
      systemPromptLength: systemPrompt?.length || 0,
      historyMessageCount: loadedMessages.length,
    },
    'Loaded messages for query',
  );

  const agentDir = path.join(AGENTS_DIR, input.agentId);
  const tools = createToolRegistry({
    workspace: {
      agentDir,
      projectDir: process.cwd(),
      globalDir: path.join(AGENTS_DIR, 'global'),
      isMain: input.isMain,
    },
    nanoclawContext: {
      chatJid: input.chatJid,
      agentId: input.agentId,
      isMain: input.isMain,
    },
    nanoclawDeps: {
      sendMessage: deps.sendMessage,
      schedulerDeps: deps.schedulerDeps,
    },
  });

  let responseMessages: ModelMessage[] = [];
  let usageTokens = 0;
  let responseText = '';
  let chunkCount = 0;
  let lastChunkTime = Date.now();

  logger.info(
    { agent: input.agentId, sessionId, model: config.modelName },
    'Calling streamText',
  );

  const streamStartTime = Date.now();
  let streamError: Error | null = null;

  logger.debug({ msgs: messages.length }, 'messages being sent to the stream');

  try {
    // Wrap model with reasoning extraction middleware
    const wrappedModel = wrapLanguageModel({
      model,
      middleware: extractReasoningMiddleware({ tagName: 'reasoning' }),
    });

    const result = streamText({
      model: wrappedModel,
      messages,
      tools,
      onError: (event) => {
        const error = event.error as any;
        logger.error(
          {
            agent: input.agentId,
            sessionId,
            error: JSON.stringify(event.error, Object.keys(event.error as any)),
            chunkCount,
            model: config.modelName,
            provider: config.provider,
          },
          'Stream failed to process',
        );
      },
      maxOutputTokens: undefined,
      stopWhen: stepCountIs(500),
      onFinish: (event) => {
        responseMessages = event.response.messages ?? [];
        usageTokens = event.totalUsage?.totalTokens ?? 0;

        const responseImageDiagnostics = getImagePayloadDiagnostics(
          responseMessages,
          0,
        );
        const responsePayloadDiagnostics =
          getMessagePayloadDiagnostics(responseMessages);
        const lastAssistant = responseMessages
          .filter((m) => m.role === 'assistant')
          .pop();

        // Fire and forget - don't block on pruning
        pruneToolOutputs(input.chatJid, sessionId).catch((err) => {
          logger.warn({ jid: input.chatJid, sessionId, err }, 'Pruning failed');
        });

        // Check for mid-stream overflow
        const threshold = getCompactionThreshold(config);
        getSessionTokenCount(input.chatJid, sessionId).then((tokenCount) => {
          const currentTokens = tokenCount + usageTokens;
          if (currentTokens >= threshold && !activeCompactions.has(sessionId)) {
            logger.warn(
              {
                agent: input.agentId,
                sessionId,
                currentTokens,
                threshold,
                overflow: currentTokens - threshold,
              },
              'Context overflow detected mid-stream',
            );
          }
        });

        logger.debug(
          {
            agent: input.agentId,
            sessionId,
            responseMessageCount: responseMessages.length,
            stepCount: event.stepNumber,
            usageTokens,
            finishReason: event.finishReason,
            responseImageDiagnostics,
            responsePayloadDiagnostics,
            lastAssistantKeys: lastAssistant
              ? Object.keys(lastAssistant as Record<string, unknown>)
              : [],
            lastAssistantContentType: lastAssistant
              ? Array.isArray(lastAssistant.content)
                ? 'array'
                : typeof lastAssistant.content
              : 'none',
          },
          'streamText onFinish callback',
        );
      },
    });

    // Consume the stream to drive completion
    for await (const chunk of result.textStream) {
      chunkCount++;
      const now = Date.now();
      const timeSinceLastChunk = now - lastChunkTime;
      lastChunkTime = now;

      // Log every 50 chunks and warn if chunks are taking too long
      if (chunkCount % 50 === 0) {
        logger.debug(
          {
            agent: input.agentId,
            sessionId,
            chunkCount,
            timeSinceLastChunk,
          },
          'Streaming in progress',
        );
      }

      if (timeSinceLastChunk > 30000) {
        logger.warn(
          {
            agent: input.agentId,
            sessionId,
            chunkCount,
            timeSinceLastChunk,
          },
          'Long delay between chunks (>30s)',
        );
      }
    }

    const streamDuration = Date.now() - streamStartTime;
    logger.info(
      {
        agent: input.agentId,
        sessionId,
        chunkCount,
        streamDurationMs: streamDuration,
        usageTokens,
      },
      'Streaming completed',
    );
  } catch (err) {
    streamError = err instanceof Error ? err : new Error(String(err));
    const streamDuration = Date.now() - streamStartTime;
    logger.error(
      {
        agent: input.agentId,
        sessionId,
        error: streamError.message,
        stack: streamError.stack,
        chunkCount,
        model: config.modelName,
        provider: config.provider,
      },
      'streamText failed',
    );
    throw streamError;
  }

  // Extract final assistant response from messages (more reliable, especially when tools are used)
  if (responseMessages.length > 0) {
    const lastAssistant = responseMessages
      .filter((m) => m.role === 'assistant')
      .pop();
    if (lastAssistant) {
      responseText = extractContentText(lastAssistant) || '';
      logger.debug(
        {
          agent: input.agentId,
          sessionId,
          responseLength: responseText.length,
        },
        'Extracted response from messages',
      );
    }
  }

  // Fallback: if no assistant message in responseMessages but we have stream text
  if (!responseText && chunkCount > 0) {
    logger.warn(
      { agent: input.agentId, sessionId, chunkCount },
      'No assistant message in responseMessages, stream may have had text',
    );
  }

  if (responseMessages.length === 0) {
    logger.warn(
      {
        agent: input.agentId,
        sessionId,
        chunkCount,
        responseLength: responseText.length,
      },
      'No response messages after streaming - possible model failure',
    );
  }

  // Save messages to session store
  await saveMessage(
    input.chatJid,
    input.agentId,
    sessionId,
    { role: 'user', content: prompt },
    null,
  );

  let tokenAssigned = false;
  for (const message of responseMessages) {
    const tokenCount =
      !tokenAssigned && message.role === 'assistant' ? usageTokens : null;
    if (tokenCount != null) tokenAssigned = true;

    // Truncate tool results in-flight to prevent context overflow
    // This happens BEFORE saving, so massive outputs don't bloat the context
    const truncatedMessage = truncateToolResultsInMessage(message);

    saveMessage(
      input.chatJid,
      input.agentId,
      sessionId,
      truncatedMessage,
      tokenCount,
    ).catch((err) => {
      logger.warn(
        { jid: input.chatJid, sessionId, err },
        'Failed to save message',
      );
    });
  }

  const totalDuration = Date.now() - queryStartTime;
  logger.info(
    {
      agent: input.agentId,
      sessionId,
      responseLength: responseText.length,
      responseMessageCount: responseMessages.length,
      usageTokens,
      chunkCount,
      totalDurationMs: totalDuration,
      streamDurationMs: Date.now() - streamStartTime,
    },
    'Query completed successfully',
  );

  // Extract pending attachments from tool results
  const pendingAttachments: Array<{ filePath: string; caption: string }> = [];

  for (const message of responseMessages) {
    if (message.role === 'tool') {
      // Tool result messages contain the results of tool calls
      const content = message.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (isToolResultPart(part) && part.toolName === 'SendAttachment') {
            try {
              const result =
                typeof part.output === 'string'
                  ? JSON.parse(part.output)
                  : part.output;
              if (result && result.value.success && result.value.filePath) {
                pendingAttachments.push({
                  filePath: result.value.filePath,
                  caption: result.value.caption || '',
                });
              }
            } catch {
              // Not JSON or invalid format, skip
            }
          }
        }
      }
    }
  }

  return {
    newSessionId: sessionId,
    responseText,
    usageTokens,
    pendingAttachments,
  };
}

async function maybeCompactSession(
  input: AgentInput,
  sessionId: string,
  usageTokens: number,
): Promise<void> {
  const config = getModelConfig(input.modelProvider, input.modelName);
  const threshold = getCompactionThreshold(config);

  const currentTokens =
    (await getSessionTokenCount(input.chatJid, sessionId)) + (usageTokens || 0);

  logger.debug(
    {
      agent: input.agentId,
      sessionId,
      contextWindow: config.contextWindow,
      threshold,
      thresholdPercent: config.compactionThresholdPercent,
      currentTokens,
      tokensToThreshold: Math.max(0, threshold - currentTokens),
      percentOfThreshold: Math.floor((currentTokens / threshold) * 100),
      willCompact:
        currentTokens >= threshold && !activeCompactions.has(sessionId),
      compactionInProgress: activeCompactions.has(sessionId),
    },
    'Compaction check (post-query)',
  );

  if (currentTokens < threshold || activeCompactions.has(sessionId)) return;

  activeCompactions.add(sessionId);
  await compactSession(input, sessionId);
  activeCompactions.delete(sessionId);
}

async function maybeCompactSessionPreflight(
  input: AgentInput,
  sessionId: string,
  promptText: string,
): Promise<void> {
  const config = getModelConfig(input.modelProvider, input.modelName);
  const threshold = getCompactionThreshold(config);

  if (activeCompactions.has(sessionId)) {
    logger.debug(
      { agent: input.agentId, sessionId },
      'Skipping preflight compaction - already in progress',
    );
    return;
  }

  // Load only uncompacted messages
  const messages = await loadMessages(input.chatJid, sessionId);
  if (messages.length < 4) {
    logger.debug(
      { agent: input.agentId, sessionId, messageCount: messages.length },
      'Skipping preflight compaction - insufficient messages',
    );
    return;
  }

  // Use context module's token estimation
  const estimatedTokens =
    estimateTokenCount(messages) + Math.ceil(promptText.length / 4);

  // Estimate image tokens if vision model and images in prompt
  let estimatedImageTokens = 0;
  let imagePathCount = 0;
  if (config.supportsVision) {
    imagePathCount = extractImagePathsFromMediaNotes(promptText).length;
    // Vision models typically use ~1000-2000 tokens per image depending on size
    // Base64 encoding adds ~33% overhead, and each base64 char is ~0.75 tokens
    estimatedImageTokens = imagePathCount * 1500; // Conservative estimate
  }

  const totalEstimatedTokens = estimatedTokens + estimatedImageTokens;

  logger.debug(
    {
      agent: input.agentId,
      sessionId,
      contextWindow: config.contextWindow,
      threshold,
      thresholdPercent: config.compactionThresholdPercent,
      estimatedTokens,
      estimatedImageTokens,
      totalEstimatedTokens,
      promptTokens: Math.ceil(promptText.length / 4),
      tokensToThreshold: Math.max(0, threshold - totalEstimatedTokens),
      percentOfThreshold: Math.floor((totalEstimatedTokens / threshold) * 100),
      willCompact: totalEstimatedTokens >= threshold,
      messageCount: messages.length,
      imageCount: imagePathCount,
    },
    'Compaction check (pre-flight)',
  );

  if (totalEstimatedTokens < threshold) return;

  // Re-check after pruning
  const prunedMessages = await loadMessages(input.chatJid, sessionId);
  const newEstimate =
    estimateTokenCount(prunedMessages) +
    Math.ceil(promptText.length / 4) +
    estimatedImageTokens;

  if (newEstimate < threshold) {
    logger.info(
      {
        agent: input.agentId,
        sessionId,
        before: totalEstimatedTokens,
        after: newEstimate,
      },
      'Pruning avoided compaction',
    );
    return;
  }

  activeCompactions.add(sessionId);
  await compactSession(input, sessionId);
  activeCompactions.delete(sessionId);
}

async function compactSession(
  input: AgentInput,
  sessionId: string,
): Promise<void> {
  const compactionStart = Date.now();
  logger.info(
    { agent: input.agentId, sessionId, chatJid: input.chatJid },
    'Starting session compaction',
  );

  try {
    const messages = await loadMessages(input.chatJid, sessionId);
    if (messages.length < 4) {
      logger.debug(
        { agent: input.agentId, sessionId, messageCount: messages.length },
        'Skipping compaction - insufficient messages',
      );
      return;
    }

    const userIndexes = messages
      .map((msg, idx) => (msg.role === 'user' ? idx : -1))
      .filter((idx) => idx !== -1) as number[];
    if (userIndexes.length < 2) {
      logger.debug(
        {
          agent: input.agentId,
          sessionId,
          userMessageCount: userIndexes.length,
        },
        'Skipping compaction - insufficient user messages',
      );
      return;
    }

    const splitIndex = userIndexes[userIndexes.length - 2];
    const older = messages.slice(0, splitIndex);
    const recent = messages.slice(splitIndex);
    if (older.length === 0) {
      logger.debug(
        { agent: input.agentId, sessionId },
        'Skipping compaction - no older messages',
      );
      return;
    }

    const config = getModelConfig(input.modelProvider, input.modelName);
    const model = createModel(config, 'compaction');

    const summaryPrompt = buildSummaryPrompt(older);
    let summaryText = '';
    let summaryChunkCount = 0;
    const summaryStreamStart = Date.now();

    logger.debug(
      { agent: input.agentId, sessionId, promptLength: summaryPrompt.length },
      'Calling streamText for summary',
    );

    const summaryResult = streamText({
      model,
      messages: [
        {
          role: 'system',
          content:
            'Provide a detailed summary for continuing our conversation. Focus on information that would be helpful for continuing the conversation, including what we did, what we are doing, which files we are working on, and what we are going to do next.',
        },
        { role: 'user', content: summaryPrompt },
      ],
      maxOutputTokens: 2048,
    });

    for await (const chunk of summaryResult.textStream) {
      summaryText += chunk;
      summaryChunkCount++;
    }

    const summaryDuration = Date.now() - summaryStreamStart;

    // Create summary message with compaction marker
    const summaryMessage: ModelMessage = {
      role: 'system',
      content: `Summary of earlier conversation:\n${summaryText.trim()}`,
    };

    // Filter out tool messages from recent to prevent context overflow
    // Tool results in recent messages can be massive and cause the prompt to exceed limits
    // The summary already captures what was done, so we don't need the full tool outputs
    const filteredRecent = recent.filter((msg) => msg.role !== 'tool');

    // Replace messages: summary + filtered recent (without tool messages)
    await replaceSessionMessages(input.chatJid, input.agentId, sessionId, [
      summaryMessage,
      ...filteredRecent,
    ]);

    // Save compaction output to agent workspace for visibility
    const timestamp = new Date().toISOString();
    await saveCompactionOutput(
      input.agentId,
      sessionId,
      input.chatJid,
      summaryText,
      older.length,
      timestamp,
    );

    const totalDuration = Date.now() - compactionStart;
    logger.info(
      {
        agent: input.agentId,
        sessionId,
        olderMessageCount: older.length,
        summaryLength: summaryText.length,
        summaryChunkCount,
        summaryDurationMs: summaryDuration,
        totalDurationMs: totalDuration,
      },
      'Session compacted successfully',
    );
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error(
      {
        agent: input.agentId,
        sessionId,
        error: error.message,
        stack: error.stack,
        durationMs: Date.now() - compactionStart,
      },
      'Compaction failed',
    );

    throw err;
  }
}

function buildSummaryPrompt(messages: ModelMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const content = extractContentText(msg);
    if (!content) continue;
    const label =
      msg.role === 'user'
        ? 'User'
        : msg.role === 'assistant'
          ? 'Assistant'
          : msg.role === 'system'
            ? 'System'
            : 'Tool';
    lines.push(`${label}: ${content}`);
  }
  return lines.join('\n');
}

function estimateTokenCount(messages: ModelMessage[]): number {
  let charCount = 0;
  for (const msg of messages) {
    const content = extractContentText(msg);
    if (content) charCount += content.length;
    const toolCalls = extractToolCalls(msg);
    if (toolCalls.length > 0) {
      charCount += JSON.stringify(toolCalls).length;
    }
  }
  return Math.ceil(charCount / 4);
}

function archiveConversation(
  jid: string,
  sessionId: string,
  messages: ModelMessage[],
): void {
  try {
    // Store archives in the session folder
    const conversationsDir = path.join(
      SESSIONS_DIR,
      jid.replace(/[:@]/g, '_'),
      'conversations',
    );
    fs.mkdirSync(conversationsDir, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}-${sessionId.slice(0, 8)}.md`;
    const filePath = path.join(conversationsDir, filename);
    const markdown = formatTranscriptMarkdown(messages);
    fs.writeFileSync(filePath, markdown);
    logger.debug(`Archived conversation to ${filePath}`);
  } catch (err) {
    logger.warn(
      `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function formatTranscriptMarkdown(messages: ModelMessage[]): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push('# Conversation');
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const label =
      msg.role === 'user'
        ? 'User'
        : msg.role === 'assistant'
          ? 'Assistant'
          : msg.role === 'system'
            ? 'System'
            : 'Tool';
    const content = extractContentText(msg) || '';
    const toolCalls = extractToolCalls(msg);
    if (toolCalls.length > 0) {
      lines.push(`**${label} (tool calls)**: ${JSON.stringify(toolCalls)}`);
    }
    if (content) {
      lines.push(`**${label}**: ${content}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function extractContentText(message: ModelMessage): string | null {
  const content = message.content;
  logger.debug(
    {
      role: message.role,
      contentType: Array.isArray(content) ? 'array' : typeof content,
      hasContent: !!content,
      keys: Object.keys(message as Record<string, unknown>),
    },
    'extractContentText input',
  );
  if (typeof content === 'string') return content;
  if (!content) return null;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (isTextPart(part)) {
          return part.text ?? '';
        }
        if (isToolResultPart(part)) {
          if (typeof part.output === 'string') return part.output;
          try {
            return JSON.stringify(redactImageDataPayloads(part.output));
          } catch {
            return String(part.output ?? '');
          }
        }
        return '';
      })
      .join('')
      .trim();
  }
  return String(content);
}

function redactImageDataPayloads(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactImageDataPayloads(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;

  if (record.type === 'image-data' && typeof record.data === 'string') {
    return {
      ...record,
      data: '[image-data omitted]',
      dataBytes: Buffer.byteLength(record.data, 'utf-8'),
    };
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    redacted[key] = redactImageDataPayloads(child);
  }

  return redacted;
}

function extractToolCalls(message: ModelMessage): Array<{
  toolName: string;
  toolCallId: string;
  input: unknown;
}> {
  if (message.role !== 'assistant') return [];
  if (!Array.isArray(message.content)) return [];
  return (message.content as ToolCallPart[])
    .filter(isToolCallPart)
    .map((part) => ({
      toolName: part.toolName,
      toolCallId: part.toolCallId,
      input: part.input,
    }));
}

function isTextPart(part: unknown): part is { text: string | undefined } {
  return (
    !!part &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'text' &&
    'text' in part
  );
}

function isToolCallPart(part: unknown): part is ToolCallPart {
  return (
    !!part &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'tool-call' &&
    typeof (part as { toolName?: unknown }).toolName === 'string' &&
    typeof (part as { toolCallId?: unknown }).toolCallId === 'string'
  );
}

function isToolResultPart(part: unknown): part is ToolResultPart {
  return (
    !!part &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'tool-result' &&
    typeof (part as { toolName?: unknown }).toolName === 'string' &&
    typeof (part as { toolCallId?: unknown }).toolCallId === 'string'
  );
}

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  const run = async (input: AgentInput): Promise<AgentOutput> => {
    const startTime = Date.now();
    const runId = `${input.agentId}-${startTime}`;

    logger.info(
      {
        runId,
        agent: input.agentId,
        chatJid: input.chatJid,
        sessionId: input.sessionId,
        promptLength: input.prompt.length,
        isScheduledTask: input.isScheduledTask,
        modelProvider: input.modelProvider,
        modelName: input.modelName,
      },
      'Agent run starting',
    );

    validateRequestedModel(input);

    if (!input.modelProvider) input.modelProvider = DEFAULT_MODEL_PROVIDER;
    if (!input.modelName) input.modelName = DEFAULT_MODEL_NAME;

    logger.debug(
      {
        runId,
        agent: input.agentId,
        provider: input.modelProvider,
        model: input.modelName,
      },
      'Using model configuration',
    );

    const agentDir = path.join(AGENTS_DIR, input.agentId);
    fs.mkdirSync(agentDir, { recursive: true });

    const sessionId =
      input.sessionId || getOrCreateSessionId(input.chatJid, input.agentId);
    let prompt = input.prompt;
    if (input.isScheduledTask) {
      prompt =
        '[SCHEDULED TASK - The following instruction is running automatically and is not a direct user/group message.]\n\n' +
        'You are executing a scheduled task. Return ONLY the final user-facing message content that should be posted.\n' +
        'Do NOT include task metadata, confirmations, or status text (for example: task IDs, next run times, or "task executed").\n' +
        'Do NOT call the send_message tool for the main result of a scheduled task; your returned text will be sent automatically.\n' +
        'Only include extra explanatory text if the task prompt explicitly asks for it.\n\n' +
        prompt;
    }

    try {
      await maybeCompactSessionPreflight(input, sessionId, prompt);

      const { responseText, usageTokens, pendingAttachments } = await runQuery(
        prompt,
        sessionId,
        input,
        deps,
      );

      // Trigger compaction asynchronously after response
      void maybeCompactSession(input, sessionId, usageTokens);

      const totalDuration = Date.now() - startTime;
      logger.info(
        {
          runId,
          agent: input.agentId,
          totalDurationMs: totalDuration,
          responseLength: responseText.length,
          sessionId,
        },
        'Agent run completed successfully',
      );

      return {
        status: 'success',
        result: responseText,
        newSessionId: sessionId,
        pendingAttachments,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorStack = err instanceof Error ? err.stack : undefined;

      logger.error(
        {
          runId,
          agent: input.agentId,
          error: errorMessage,
          stack: errorStack,
          durationMs: Date.now() - startTime,
          sessionId,
        },
        'Agent run error',
      );

      return {
        status: 'error',
        result: null,
        newSessionId: sessionId,
        error: errorMessage,
      };
    }
  };

  return { run };
}
