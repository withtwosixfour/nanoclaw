/**
 * NanoClaw Agent Runner (Vercel AI SDK)
 * Runs inside a container, receives config via stdin, outputs result to stdout
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { streamText, type CoreMessage } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';

import { createToolRegistry } from './tools/index.js';
import {
  getCompactionThreshold,
  getDefaultModel,
  getModelConfig,
} from './model-config.js';
import {
  getOrCreateSessionId,
  getSessionTokenCount,
  loadMessages,
  replaceSessionMessages,
  saveMessage,
} from './session-store.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
  modelProvider?: string;
  modelName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

const activeCompactions = new Set<string>();

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function buildSystemPrompt(isMain: boolean): string {
  const groupClaude = '/workspace/group/CLAUDE.md';
  const globalClaude = '/workspace/global/CLAUDE.md';
  const parts: string[] = [];

  if (fs.existsSync(groupClaude)) {
    parts.push(fs.readFileSync(groupClaude, 'utf-8').trim());
  }

  if (!isMain && fs.existsSync(globalClaude)) {
    parts.push(fs.readFileSync(globalClaude, 'utf-8').trim());
  }

  return parts.filter(Boolean).join('\n\n');
}

function createModel(
  configProvider: string,
  modelName: string,
  secrets?: Record<string, string>,
) {
  if (configProvider !== 'anthropic') {
    log(`Unknown provider ${configProvider}, falling back to anthropic`);
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
  containerInput: ContainerInput,
  mcpServerPath: string,
): Promise<{
  newSessionId: string;
  responseText: string;
  usageTokens: number;
}> {
  const config = getModelConfig(
    containerInput.modelProvider,
    containerInput.modelName,
  );
  const model = createModel(
    config.provider,
    config.modelName,
    containerInput.secrets,
  );

  const systemPrompt = buildSystemPrompt(containerInput.isMain);
  const messages: CoreMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push(...loadMessages(containerInput.groupFolder, sessionId));
  messages.push({ role: 'user', content: prompt });

  const tools = createToolRegistry({
    mcpServerPath,
    mcpEnv: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    },
  }) as Record<string, any>;

  let responseMessages: CoreMessage[] = [];
  let usageTokens = 0;
  let responseText = '';

  const result = streamText({
    model,
    messages,
    tools: tools as Record<string, any>,
    maxTokens: config.maxOutputTokens,
    maxSteps: 8,
    onFinish: (result: {
      response?: { messages?: CoreMessage[] };
      usage?: { totalTokens?: number };
    }) => {
      responseMessages = result.response?.messages || [];
      usageTokens = result.usage?.totalTokens ?? 0;
    },
  });

  for await (const chunk of result.textStream) {
    responseText += chunk;
  }

  if (responseMessages.length === 0 && responseText) {
    responseMessages = [
      { role: 'assistant', content: responseText } as CoreMessage,
    ];
  }

  saveMessage(
    containerInput.groupFolder,
    sessionId,
    { role: 'user', content: prompt } as CoreMessage,
    null,
  );

  let tokenAssigned = false;
  for (const message of responseMessages) {
    const tokenCount =
      !tokenAssigned && message.role === 'assistant' ? usageTokens : null;
    if (tokenCount != null) tokenAssigned = true;
    saveMessage(containerInput.groupFolder, sessionId, message, tokenCount);
  }

  return { newSessionId: sessionId, responseText, usageTokens };
}

async function maybeCompactSession(
  containerInput: ContainerInput,
  sessionId: string,
  usageTokens: number,
): Promise<void> {
  const config = getModelConfig(
    containerInput.modelProvider,
    containerInput.modelName,
  );
  const threshold = getCompactionThreshold(config);

  const currentTokens = getSessionTokenCount(sessionId) + (usageTokens || 0);
  if (currentTokens < threshold || activeCompactions.has(sessionId)) return;
  
  activeCompactions.add(sessionId);
  await compactSession(containerInput, sessionId);
  activeCompactions.delete(sessionId);
}

async function compactSession(
  containerInput: ContainerInput,
  sessionId: string,
): Promise<void> {
  try {
    const messages = loadMessages(containerInput.groupFolder, sessionId);
    if (messages.length < 4) return;

    const userIndexes = messages
      .map((msg, idx) => (msg.role === 'user' ? idx : -1))
      .filter((idx) => idx !== -1) as number[];
    if (userIndexes.length < 2) return;

    const splitIndex = userIndexes[userIndexes.length - 2];
    const older = messages.slice(0, splitIndex);
    const recent = messages.slice(splitIndex);
    if (older.length === 0) return;

    archiveConversation(containerInput.groupFolder, sessionId, messages);

    const config = getModelConfig(
      containerInput.modelProvider,
      containerInput.modelName,
    );
    const model = createModel(
      config.provider,
      config.modelName,
      containerInput.secrets,
    );

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
      maxTokens: Math.min(2048, config.maxOutputTokens),
    });

    for await (const chunk of summaryResult.textStream) {
      summaryText += chunk;
    }

    const summaryMessage: CoreMessage = {
      role: 'system',
      content: `Summary of earlier conversation:\n${summaryText.trim()}`,
    };

    replaceSessionMessages(containerInput.groupFolder, sessionId, [
      summaryMessage,
      ...recent,
    ]);
    log(`Session ${sessionId} compacted (${older.length} -> summary)`);
  } catch (err) {
    log(
      `Compaction failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function buildSummaryPrompt(messages: CoreMessage[]): string {
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

function archiveConversation(
  groupFolder: string,
  sessionId: string,
  messages: CoreMessage[],
): void {
  try {
    const conversationsDir = '/workspace/group/conversations';
    fs.mkdirSync(conversationsDir, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}-${sessionId.slice(0, 8)}.md`;
    const filePath = path.join(conversationsDir, filename);
    const markdown = formatTranscriptMarkdown(messages);
    fs.writeFileSync(filePath, markdown);
    log(`Archived conversation to ${filePath}`);
  } catch (err) {
    log(
      `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function formatTranscriptMarkdown(messages: CoreMessage[]): string {
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
    const toolCalls = (msg as { toolCalls?: unknown }).toolCalls;
    if (toolCalls) {
      lines.push(`**${label} (tool calls)**: ${JSON.stringify(toolCalls)}`);
    }
    if (content) {
      lines.push(`**${label}**: ${content}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function extractContentText(message: CoreMessage): string | null {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!content) return null;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .join('')
      .trim();
  }
  return String(content);
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* ignore */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  const defaults = getDefaultModel();
  if (!containerInput.modelProvider)
    containerInput.modelProvider = defaults.provider;
  if (!containerInput.modelName) containerInput.modelName = defaults.modelName;

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId =
    containerInput.sessionId ||
    getOrCreateSessionId(containerInput.groupFolder);
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  try {
    while (true) {
      log(`Starting query (session: ${sessionId})...`);
      const { newSessionId, responseText, usageTokens } = await runQuery(
        prompt,
        sessionId,
        containerInput,
        mcpServerPath,
      );
      sessionId = newSessionId;

      writeOutput({
        status: 'success',
        result: responseText || null,
        newSessionId: sessionId,
      });

      void maybeCompactSession(containerInput, sessionId, usageTokens);

      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
