import fs from 'fs';
import path from 'path';
import {
  streamText,
  stepCountIs,
  type ModelMessage,
  type ToolCallPart,
  type ToolResultPart,
} from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

import { AGENTS_DIR, SESSIONS_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Agent } from '../types.js';
import { createToolRegistry } from './tool-registry.js';
import { getCompactionThreshold, getModelConfig } from './model-config.js';
import {
  getOrCreateSessionId,
  getSessionTokenCount,
  loadMessages,
  replaceSessionMessages,
  saveMessage,
} from './session-store.js';

const DEFAULT_MODEL_PROVIDER = 'opencode-zen';
const DEFAULT_MODEL_NAME = 'kimi-k2.5';

const activeCompactions = new Set<string>();

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
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export interface AgentRuntimeDeps {
  sendMessage: (jid: string, text: string, sender?: string) => Promise<void>;
  registerAgent: (jid: string, agent: Agent) => void;
  getRegisteredAgents: () => Record<string, Agent>;
}

export interface AgentRuntime {
  run: (
    input: AgentInput,
    onOutput?: (output: AgentOutput) => Promise<void>,
  ) => Promise<AgentOutput>;
  pipeMessage: (groupJid: string, text: string) => boolean;
  close: (groupJid: string) => void;
}

interface PipeState {
  queue: string[];
  waiters: Array<(message: string | null) => void>;
  closed: boolean;
}

interface AgentSecrets {
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  OPENCODE_ZEN_API_KEY?: string;
}

function readSecrets(): AgentSecrets {
  return readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENCODE_ZEN_API_KEY',
  ]);
}

function buildSystemPrompt(agentId: string, isMain: boolean): string {
  const agentClaude = path.join(AGENTS_DIR, agentId, 'CLAUDE.md');
  const globalClaude = path.join(AGENTS_DIR, 'global', 'CLAUDE.md');
  const parts: string[] = [];

  if (fs.existsSync(agentClaude)) {
    parts.push(fs.readFileSync(agentClaude, 'utf-8').trim());
  }

  if (!isMain && fs.existsSync(globalClaude)) {
    parts.push(fs.readFileSync(globalClaude, 'utf-8').trim());
  }

  return parts.filter(Boolean).join('\n\n');
}

function createModel(
  configProvider: string,
  modelName: string,
  secrets?: AgentSecrets,
) {
  if (configProvider === 'opencode-zen') {
    const apiKey =
      secrets?.OPENCODE_ZEN_API_KEY || process.env.OPENCODE_ZEN_API_KEY;
    const provider = createOpenAICompatible({
      name: 'opencode-zen',
      baseURL: 'https://opencode.ai/zen/v1',
      ...(apiKey ? { apiKey } : {}),
      includeUsage: true,
    });
    return provider(modelName);
  }

  if (configProvider !== 'anthropic') {
    logger.warn(
      `Unknown provider ${configProvider}, falling back to anthropic`,
    );
  }
  const apiKey = secrets?.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  const authToken =
    secrets?.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN;
  const provider = createAnthropic({
    ...(apiKey ? { apiKey } : {}),
    ...(authToken ? { authToken } : {}),
  });
  return provider(modelName);
}

async function runQuery(
  prompt: string,
  sessionId: string,
  input: AgentInput,
  secrets: AgentSecrets,
  deps: AgentRuntimeDeps,
): Promise<{
  newSessionId: string;
  responseText: string;
  usageTokens: number;
}> {
  const config = getModelConfig(input.modelProvider, input.modelName);
  const model = createModel(config.provider, config.modelName, secrets);

  const systemPrompt = buildSystemPrompt(input.agentId, input.isMain);
  const messages: ModelMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push(...loadMessages(input.chatJid, sessionId));
  messages.push({ role: 'user', content: prompt });

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
      registerAgent: deps.registerAgent,
      getRegisteredAgents: deps.getRegisteredAgents,
    },
  }) as Record<string, any>;

  let responseMessages: ModelMessage[] = [];
  let usageTokens = 0;
  let responseText = '';

  const result = streamText({
    model,
    messages,
    tools,
    maxOutputTokens: config.maxOutputTokens,
    stopWhen: stepCountIs(500),
    onFinish: (event: any) => {
      responseMessages = event.response?.messages ?? [];
      usageTokens = event.totalUsage?.totalTokens ?? 0;
    },
  });

  for await (const chunk of result.textStream) {
    responseText += chunk;
  }

  if (responseMessages.length === 0 && responseText) {
    responseMessages = [{ role: 'assistant', content: responseText }];
  }

  saveMessage(
    input.chatJid,
    sessionId,
    { role: 'user', content: prompt },
    null,
  );

  let tokenAssigned = false;
  for (const message of responseMessages) {
    const tokenCount =
      !tokenAssigned && message.role === 'assistant' ? usageTokens : null;
    if (tokenCount != null) tokenAssigned = true;
    saveMessage(input.chatJid, sessionId, message, tokenCount);
  }

  return { newSessionId: sessionId, responseText, usageTokens };
}

async function maybeCompactSession(
  input: AgentInput,
  sessionId: string,
  usageTokens: number,
  secrets: AgentSecrets,
): Promise<void> {
  const config = getModelConfig(input.modelProvider, input.modelName);
  const threshold = getCompactionThreshold(config);

  const currentTokens =
    getSessionTokenCount(input.chatJid, sessionId) + (usageTokens || 0);
  if (currentTokens < threshold || activeCompactions.has(sessionId)) return;

  activeCompactions.add(sessionId);
  await compactSession(input, sessionId, secrets);
  activeCompactions.delete(sessionId);
}

async function maybeCompactSessionPreflight(
  input: AgentInput,
  sessionId: string,
  promptText: string,
  secrets: AgentSecrets,
): Promise<void> {
  const config = getModelConfig(input.modelProvider, input.modelName);
  const threshold = getCompactionThreshold(config);
  if (activeCompactions.has(sessionId)) return;

  const messages = loadMessages(input.chatJid, sessionId);
  if (messages.length < 4) return;

  const estimatedTokens =
    estimateTokenCount(messages) + Math.ceil(promptText.length / 4);
  if (estimatedTokens < threshold) return;

  activeCompactions.add(sessionId);
  await compactSession(input, sessionId, secrets);
  activeCompactions.delete(sessionId);
}

async function compactSession(
  input: AgentInput,
  sessionId: string,
  secrets: AgentSecrets,
): Promise<void> {
  try {
    const messages = loadMessages(input.chatJid, sessionId);
    if (messages.length < 4) return;

    const userIndexes = messages
      .map((msg, idx) => (msg.role === 'user' ? idx : -1))
      .filter((idx) => idx !== -1) as number[];
    if (userIndexes.length < 2) return;

    const splitIndex = userIndexes[userIndexes.length - 2];
    const older = messages.slice(0, splitIndex);
    const recent = messages.slice(splitIndex);
    if (older.length === 0) return;

    archiveConversation(input.chatJid, sessionId, messages);

    const config = getModelConfig(input.modelProvider, input.modelName);
    const model = createModel(config.provider, config.modelName, secrets);

    const summaryPrompt = buildSummaryPrompt(older);
    let summaryText = '';
    const summaryResult = streamText({
      model,
      messages: [
        {
          role: 'system',
          content:
            'Summarize the earlier conversation for future context. Be concise and preserve key facts, decisions, preferences, and open tasks.',
        },
        { role: 'user', content: summaryPrompt },
      ],
      maxOutputTokens: Math.min(2048, config.maxOutputTokens),
    });

    for await (const chunk of summaryResult.textStream) {
      summaryText += chunk;
    }

    const summaryMessage: ModelMessage = {
      role: 'system',
      content: `Summary of earlier conversation:\n${summaryText.trim()}`,
    };

    replaceSessionMessages(input.chatJid, sessionId, [
      summaryMessage,
      ...recent,
    ]);
    logger.debug(`Session ${sessionId} compacted (${older.length} -> summary)`);
  } catch (err) {
    logger.warn(
      `Compaction failed: ${err instanceof Error ? err.message : String(err)}`,
    );
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
  if (typeof content === 'string') return content;
  if (!content) return null;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (isTextPart(part)) {
          return part.text ?? '';
        }
        if (isToolResultPart(part)) {
          if (typeof part.output === 'string') return part.output;
          try {
            return JSON.stringify(part.output);
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
  return !!part && typeof part === 'object' && 'text' in part;
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

function buildPipeState(): PipeState {
  return { queue: [], waiters: [], closed: false };
}

function drainPipe(pipe: PipeState): string[] {
  if (pipe.queue.length === 0) return [];
  const messages = pipe.queue.slice();
  pipe.queue = [];
  return messages;
}

function waitForPipeMessage(pipe: PipeState): Promise<string | null> {
  if (pipe.closed) return Promise.resolve(null);
  if (pipe.queue.length > 0) {
    const next = pipe.queue.shift() || null;
    return Promise.resolve(next);
  }
  return new Promise((resolve) => {
    pipe.waiters.push(resolve);
  });
}

function enqueuePipeMessage(pipe: PipeState, message: string): void {
  if (pipe.closed) return;
  if (pipe.waiters.length > 0) {
    const resolve = pipe.waiters.shift();
    resolve?.(message);
    return;
  }
  pipe.queue.push(message);
}

function closePipe(pipe: PipeState): void {
  pipe.closed = true;
  while (pipe.waiters.length > 0) {
    const resolve = pipe.waiters.shift();
    resolve?.(null);
  }
  pipe.queue = [];
}

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  const pipes = new Map<string, PipeState>();
  const activeRuns = new Set<string>();

  const getPipe = (groupJid: string): PipeState => {
    let pipe = pipes.get(groupJid);
    if (!pipe) {
      pipe = buildPipeState();
      pipes.set(groupJid, pipe);
    }
    return pipe;
  };

  const pipeMessage = (groupJid: string, text: string): boolean => {
    if (!activeRuns.has(groupJid)) return false;
    enqueuePipeMessage(getPipe(groupJid), text);
    return true;
  };

  const close = (groupJid: string): void => {
    closePipe(getPipe(groupJid));
  };

  const run = async (
    input: AgentInput,
    onOutput?: (output: AgentOutput) => Promise<void>,
  ): Promise<AgentOutput> => {
    const startTime = Date.now();
    const secrets = readSecrets();

    if (!input.modelProvider) input.modelProvider = DEFAULT_MODEL_PROVIDER;
    if (!input.modelName) input.modelName = DEFAULT_MODEL_NAME;

    const agentDir = path.join(AGENTS_DIR, input.agentId);
    fs.mkdirSync(agentDir, { recursive: true });

    const pipe = getPipe(input.chatJid);
    pipe.closed = false;
    activeRuns.add(input.chatJid);

    let sessionId =
      input.sessionId || getOrCreateSessionId(input.chatJid, input.agentId);
    let prompt = input.prompt;
    if (input.isScheduledTask) {
      prompt =
        '[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n' +
        prompt;
    }

    const pending = drainPipe(pipe);
    if (pending.length > 0) {
      logger.debug(
        { agent: input.agentId, count: pending.length },
        'Draining pending piped messages into initial prompt',
      );
      prompt += '\n' + pending.join('\n');
    }

    // Track the last response - only send the final one at the end
    let lastResponse: string | null = null;
    let hadError = false;
    let errorMessage = '';

    try {
      while (true) {
        logger.debug(
          { agent: input.agentId, sessionId },
          'Starting agent query',
        );
        await maybeCompactSessionPreflight(input, sessionId, prompt, secrets);
        const { newSessionId, responseText, usageTokens } = await runQuery(
          prompt,
          sessionId,
          input,
          secrets,
          deps,
        );
        sessionId = newSessionId;

        // Store this response (will be overwritten if more piped messages arrive)
        if (responseText) {
          lastResponse = responseText;
        }

        void maybeCompactSession(input, sessionId, usageTokens, secrets);

        const nextMessage = await waitForPipeMessage(pipe);
        if (nextMessage === null) {
          logger.debug(
            { agent: input.agentId, durationMs: Date.now() - startTime },
            'Agent run closed',
          );
          break;
        }
        prompt = nextMessage;
      }

      // Send only the final response once at the end
      if (onOutput) {
        await onOutput({
          status: 'success',
          result: lastResponse,
          newSessionId: sessionId,
        });
        // Send completion marker
        await onOutput({
          status: 'success',
          result: null,
          newSessionId: sessionId,
        });
      }

      return {
        status: 'success',
        result: lastResponse,
        newSessionId: sessionId,
      };
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      hadError = true;
      logger.error(
        { agent: input.agentId, error: errorMessage },
        'Agent error',
      );
    } finally {
      activeRuns.delete(input.chatJid);
      closePipe(pipe);
    }

    // Handle error case - send the last response we got before the error
    if (hadError) {
      const output: AgentOutput = {
        status: 'error',
        result: lastResponse,
        newSessionId: sessionId,
        error: errorMessage,
      };
      if (onOutput) await onOutput(output);
      return output;
    }

    // This line is unreachable but satisfies TypeScript
    return {
      status: 'success',
      result: null,
      newSessionId: sessionId,
    };
  };

  return { run, pipeMessage, close };
}
