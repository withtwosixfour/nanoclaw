import { Chat, type Thread, type Message, type SlashCommandEvent } from 'chat';
import { createDiscordAdapter } from '@chat-adapter/discord';
import { createSlackAdapter } from '@chat-adapter/slack';
import { createSQLiteState } from './chat-sdk-state-sqlite.js';
import { ASSISTANT_NAME, DATA_DIR } from './config.js';
import { logger } from './logger.js';
import type { Logger as ChatLogger } from 'chat';
import { resolveAgentId, formatOutbound } from './router.js';
import {
  storeMessage,
  storeAttachment,
  storeChatMetadata,
  getAgent,
  getSession,
  setSession,
  deleteSession,
  setRouterState,
  getRouterState,
  getAllAgents,
  getAllSessions,
} from './db.js';
import {
  clearSession,
  getOrCreateSessionId,
  getSessionMessageCount,
  getSessionTokenCount,
  getSessionLastTimestamp,
} from './agent-runner/session-store.js';
import { createAgentRuntime, AgentInput } from './agent-runner/runtime.js';
import type { Agent, Attachment as InternalAttachment } from './types.js';
import { saveAttachment, buildMediaNote } from './attachments/store.js';
import { getMimeTypeFromExtension } from './attachments/images.js';
import path from 'path';
import fs from 'fs';
import type { Logger as PinoLogger } from 'pino';

// Adapter to wrap pino logger for Chat SDK compatibility
class PinoLoggerAdapter implements ChatLogger {
  constructor(
    private pinoLogger: PinoLogger,
    private prefix: string = '',
  ) {}

  child(prefix: string): ChatLogger {
    const childLogger = this.pinoLogger.child({ component: prefix });
    return new PinoLoggerAdapter(childLogger, prefix);
  }

  debug(message: string, ...args: unknown[]): void {
    if (args.length > 0) {
      this.pinoLogger.debug({ args, prefix: this.prefix }, message);
    } else {
      this.pinoLogger.debug({ prefix: this.prefix }, message);
    }
  }

  error(message: string, ...args: unknown[]): void {
    if (args.length > 0) {
      this.pinoLogger.error({ args, prefix: this.prefix }, message);
    } else {
      this.pinoLogger.error({ prefix: this.prefix }, message);
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (args.length > 0) {
      this.pinoLogger.info({ args, prefix: this.prefix }, message);
    } else {
      this.pinoLogger.info({ prefix: this.prefix }, message);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (args.length > 0) {
      this.pinoLogger.warn({ args, prefix: this.prefix }, message);
    } else {
      this.pinoLogger.warn({ prefix: this.prefix }, message);
    }
  }
}

// State management
let botInstance: Chat | null = null;
let stateAdapter: ReturnType<typeof createSQLiteState> | null = null;

// Track which messages we're processing (for 👀 reactions)
const processingMessages = new Map<
  string,
  { messageId: string; timeout: NodeJS.Timeout }
>();

/**
 * Convert our internal ID format to Chat SDK thread ID
 * Since we're now using Chat SDK thread IDs directly, this is a no-op.
 */
function jidToThreadId(jid: string): string {
  // If it starts with dc:, it's a legacy ID - convert to Chat SDK format
  if (jid.startsWith('dc:')) {
    return `discord::${jid.slice(3)}`;
  }
  // Otherwise it's already a Chat SDK thread ID
  return jid;
}

/**
 * Get last agent timestamps from DB
 */
async function getLastAgentTimestamps(): Promise<Record<string, string>> {
  const stored = await getRouterState('last_agent_timestamp');
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      return {};
    }
  }
  return {};
}
async function ensureSessionForThread(threadId: string): Promise<string> {
  const agentId = await resolveAgentId(threadId);
  if (!agentId) {
    throw new Error(`No agent configured for thread ${threadId}`);
  }

  // Check DB for existing session
  const session = await getSession(threadId);
  if (session) {
    return session.sessionId;
  }

  // Create new session
  const sessionId = getOrCreateSessionId(threadId, agentId);
  await setSession(threadId, agentId, sessionId);
  return sessionId;
}

function extractPlatformAndChannelId(
  threadId: string,
): { platform: string; channelId: string } | null {
  const parts = threadId.split(':');
  if (parts.length < 2) {
    return null;
  }

  const platform = parts[0];
  switch (platform) {
    case 'discord':
      if (parts.length >= 3) {
        return { platform, channelId: parts[2] };
      }
      if (parts.length === 2) {
        return { platform, channelId: parts[1] };
      }
      return null;
    case 'slack':
      return { platform, channelId: parts[parts.length - 1] };
    case 'teams':
      if (parts.length >= 3) {
        return { platform, channelId: parts[2] };
      }
      return null;
    case 'gchat':
      return { platform, channelId: parts[1] };
    case 'dc':
      if (!parts[1]) {
        return null;
      }
      return { platform: 'discord', channelId: parts[1] };
    default:
      return null;
  }
}

async function resolveClearTargetJids(chatJid: string): Promise<string[]> {
  const normalizedJid = jidToThreadId(chatJid);
  const targets = new Set<string>([normalizedJid]);
  const parsed = extractPlatformAndChannelId(normalizedJid);

  if (!parsed) {
    return [normalizedJid];
  }

  const sessions = await getAllSessions();
  for (const jid of Object.keys(sessions)) {
    const candidate = extractPlatformAndChannelId(jid);
    if (!candidate) {
      continue;
    }

    if (
      candidate.platform === parsed.platform &&
      candidate.channelId === parsed.channelId
    ) {
      targets.add(jid);
    }
  }

  return Array.from(targets);
}

/**
 * Resolve agent for a JID
 */
async function resolveAgentForJid(chatJid: string): Promise<Agent | null> {
  const agentId = await resolveAgentId(chatJid);
  if (!agentId) {
    return null;
  }
  return (await getAgent(agentId)) ?? null;
}

/**
 * Add 👀 reaction to show we're processing
 */
async function addAcknowledgement(
  thread: Thread,
  messageId: string,
): Promise<void> {
  try {
    // React with 👀 using the thread's raw adapter if available
    // The Discord adapter exposes methods through the adapter property
    const adapter = thread.adapter;

    await adapter.addReaction(thread.id, messageId, '👀');

    // Set safety timeout to auto-remove after 5 minutes
    const timeout = setTimeout(
      () => {
        clearAcknowledgement(thread, messageId);
      },
      5 * 60 * 1000,
    );

    processingMessages.set(thread.id, { messageId, timeout });
  } catch (err) {
    logger.error(
      { threadId: thread.id, messageId, err },
      'Failed to add acknowledgement reaction',
    );
  }
}

/**
 * Clear 👀 reaction
 */
async function clearAcknowledgement(
  thread: Thread,
  messageId: string,
): Promise<void> {
  const entry = processingMessages.get(thread.id);
  if (!entry) return;

  clearTimeout(entry.timeout);

  try {
    const adapter = thread.adapter;
    await adapter.removeReaction(thread.id, messageId, '👀');
  } catch (err) {
    logger.debug(
      { threadId: thread.id, messageId, err },
      'Failed to clear acknowledgement reaction',
    );
  } finally {
    processingMessages.delete(thread.id);
  }
}

/**
 * Process Chat SDK attachments - download, save, and build media notes
 */
async function processChatSdkAttachments(
  attachments: Array<{
    type?: string;
    url?: string;
    name?: string;
    mimeType?: string;
    size?: number;
    fetchData?: () => Promise<Buffer>;
  }>,
): Promise<{ savedAttachments: InternalAttachment[]; mediaNotes: string[] }> {
  const savedAttachments: InternalAttachment[] = [];
  const mediaNotes: string[] = [];

  for (const att of attachments) {
    try {
      let buffer: Buffer | undefined;
      let mimeType = att.mimeType || 'application/octet-stream';
      let filename = att.name || 'attachment';

      // Try fetchData first (preferred method)
      if (att.fetchData) {
        logger.debug(
          { attachment: filename, mimeType },
          'Downloading attachment via fetchData()',
        );
        buffer = await att.fetchData();
      } else if (att.url) {
        // Fallback to downloading from URL
        logger.debug(
          { attachment: filename, url: att.url },
          'Downloading attachment from URL',
        );
        const response = await fetch(att.url, {
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) {
          logger.warn(
            { attachment: filename, status: response.status },
            'Failed to download attachment',
          );
          mediaNotes.push(`[File: ${filename} - download failed]`);
          continue;
        }
        buffer = Buffer.from(await response.arrayBuffer());
      }

      if (!buffer || buffer.length === 0) {
        logger.warn({ attachment: filename }, 'Empty attachment buffer');
        mediaNotes.push(`[File: ${filename} - empty]`);
        continue;
      }

      // Save attachment to filesystem
      const savedAttachment = await saveAttachment(buffer, filename, mimeType);
      savedAttachments.push(savedAttachment);

      // Build media note
      const mediaNote = buildMediaNote(savedAttachment);
      mediaNotes.push(mediaNote);

      logger.info(
        {
          attachment: filename,
          mimeType,
          size: savedAttachment.size,
          path: savedAttachment.path,
        },
        'Attachment saved successfully',
      );
    } catch (err) {
      logger.error(
        {
          attachment: att.name,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        'Error processing attachment',
      );
      mediaNotes.push(`[File: ${att.name || 'file'} - error processing]`);
    }
  }

  return { savedAttachments, mediaNotes };
}
function handleIncomingMessage(
  chatJid: string,
  messageId: string,
  sender: string,
  senderName: string,
  content: string,
  timestamp: string,
  attachments?: Array<{
    id: string;
    filename: string;
    path: string;
    mimeType: string;
    size: number;
    createdAt: string;
  }>,
): void {
  logger.debug(
    {
      chatJid,
      messageId,
      sender,
      contentLength: content.length,
      attachmentCount: attachments?.length ?? 0,
    },
    'handleIncomingMessage: Processing message',
  );

  // First, ensure the chat exists in the database (required for foreign key constraint)
  try {
    logger.debug(
      { chatJid, timestamp },
      'handleIncomingMessage: Ensuring chat exists',
    );
    storeChatMetadata(chatJid, timestamp, senderName, 'discord', true);
    logger.debug({ chatJid }, 'handleIncomingMessage: Chat metadata stored');
  } catch (err) {
    logger.error(
      {
        chatJid,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      'handleIncomingMessage: Failed to store chat metadata',
    );
    throw err;
  }

  // Store the message
  try {
    logger.debug(
      {
        chatJid,
        messageId,
        sender,
        contentLength: content.length,
        attachmentCount: attachments?.length ?? 0,
      },
      'handleIncomingMessage: Storing message',
    );
    storeMessage({
      id: messageId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });
    logger.debug(
      { chatJid, messageId },
      'handleIncomingMessage: Message stored',
    );
  } catch (err) {
    logger.error(
      {
        chatJid,
        messageId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      'handleIncomingMessage: Failed to store message',
    );
    throw err;
  }

  if (attachments && attachments.length > 0) {
    logger.debug(
      { chatJid, messageId, attachmentCount: attachments.length },
      'handleIncomingMessage: Storing attachments',
    );
    for (const att of attachments) {
      try {
        storeAttachment(att, messageId, chatJid);
        logger.debug(
          { chatJid, messageId, attachmentId: att.id, filename: att.filename },
          'handleIncomingMessage: Attachment stored',
        );
      } catch (err) {
        logger.error(
          {
            chatJid,
            messageId,
            attachmentId: att.id,
            filename: att.filename,
            error: err instanceof Error ? err.message : String(err),
          },
          'handleIncomingMessage: Failed to store attachment',
        );
        throw err;
      }
    }
  }

  ensureSessionForThread(chatJid);
}

/**
 * Run agent with input and stream response
 */
async function runAgent(
  chatJid: string,
  agent: Agent,
  prompt: string,
  sessionId: string,
  thread: Thread,
  messageId: string,
): Promise<void> {
  const input: AgentInput = {
    prompt,
    sessionId,
    agentId: agent.id,
    chatJid,
    isMain: agent.isMain ?? false,
    modelProvider: agent.modelProvider,
    modelName: agent.modelName,
  };

  try {
    const output = await agentRuntime.run(input);

    if (output.status === 'success' && output.result) {
      // Clear acknowledgement before sending
      await clearAcknowledgement(thread, messageId);

      // Send the response
      await thread.post(output.result);

      // Update timestamp in DB
      const lastAgentTimestamps = await getLastAgentTimestamps();
      lastAgentTimestamps[chatJid] = new Date().toISOString();
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(lastAgentTimestamps),
      );
    } else if (output.status === 'error') {
      await clearAcknowledgement(thread, messageId);
      logger.error({ chatJid, error: output.error }, 'Agent error');
      await thread.post(
        'Sorry, I encountered an error processing your request.',
      );
    }

    // Handle pending attachments from SendAttachment tool calls
    if (output.pendingAttachments && output.pendingAttachments.length > 0) {
      logger.info(
        {
          agent: agent.id,
          chatJid,
          attachmentCount: output.pendingAttachments.length,
        },
        'Sending attachments',
      );

      for (const pendingAtt of output.pendingAttachments) {
        try {
          // Read the file and send via Chat SDK
          const fileBuffer = await fs.promises.readFile(pendingAtt.filePath);
          const filename = path.basename(pendingAtt.filePath);
          const mimeType = getMimeTypeFromExtension(pendingAtt.filePath);

          await thread.post({
            markdown: pendingAtt.caption || '',
            files: [
              {
                data: fileBuffer,
                filename,
                mimeType,
              },
            ],
          });

          logger.info(
            {
              filePath: pendingAtt.filePath,
              filename,
              mimeType,
              size: fileBuffer.length,
            },
            'Attachment sent',
          );
        } catch (sendErr) {
          logger.error(
            {
              agent: agent.id,
              chatJid,
              filePath: pendingAtt.filePath,
              error:
                sendErr instanceof Error ? sendErr.message : String(sendErr),
            },
            'Failed to send attachment',
          );
        }
      }
    }
  } catch (err) {
    await clearAcknowledgement(thread, messageId);
    logger.error({ chatJid, err }, 'Failed to run agent');
    await thread.post('Sorry, I encountered an error.');
  }
}

// Create agent runtime
const agentRuntime = createAgentRuntime({
  sendMessage: async (jid, text) => {
    const formatted = formatOutbound(text);
    if (!formatted) return;
    try {
      await sendMessageToJid(jid, formatted);
    } catch (err) {
      logger.error(
        { jid, err, text: formatted.slice(0, 50) },
        'Failed to send message from tool',
      );
    }
  },
  getRegisteredAgents: async () => ({}),
  schedulerDeps: {
    agents: async () => await getAllAgents(),
    getSessions: async () => {
      const sessions: Record<string, string> = {};
      const dbSessions = await getAllSessions();
      for (const [jid, data] of Object.entries(dbSessions)) {
        sessions[jid] = data.sessionId;
      }
      return sessions;
    },
    runAgent: async (input: AgentInput) => {
      return await agentRuntime.run(input);
    },
    sendMessage: async (jid: string, text: string) => {
      const formatted = formatOutbound(text);
      if (!formatted) return;
      try {
        await sendMessageToJid(jid, formatted);
      } catch (err) {
        logger.error(
          { jid, err, text: formatted.slice(0, 50) },
          'Failed to send scheduled message',
        );
      }
    },
  },
});

/**
 * Execute slash commands
 */
async function executeCommand(
  chatJid: string,
  command: string,
  sender?: string,
): Promise<string> {
  const agent = await resolveAgentForJid(chatJid);
  if (!agent) {
    return `No agent configured for this channel. Please add a route in src/router.ts.`;
  }

  const normalizedCommand = command.toLowerCase().replace(/^\//, '');

  if (normalizedCommand === 'clear') {
    const targetJids = await resolveClearTargetJids(chatJid);
    for (const targetJid of targetJids) {
      await clearSession(targetJid);
      deleteSession(targetJid);
    }
    return 'Session cleared. New conversation will start on next message.';
  } else if (normalizedCommand === 'status') {
    const session = await getSession(chatJid);
    if (!session) {
      return `Status: agent=${agent.id} session=none (no active session)`;
    }
    const modelProvider = agent.modelProvider || 'opencode-zen';
    const modelName = agent.modelName || 'kimi-k2.5';
    const messageCount = await getSessionMessageCount(
      chatJid,
      session.sessionId,
    );
    const tokenCount = await getSessionTokenCount(chatJid, session.sessionId);
    const lastTs =
      (await getSessionLastTimestamp(chatJid, session.sessionId)) || 'none';
    return `Status: agent=${agent.id} session=${session.sessionId} model=${modelProvider}/${modelName} messages=${messageCount} tokens=${tokenCount} last=${lastTs}`;
  } else if (normalizedCommand === 'chatid') {
    const threadId = jidToThreadId(chatJid);
    return `This channel's ID is: \`${threadId}\`

Add this to your \`ROUTES\` in \`src/router.ts\`:
\`\`\`typescript
'${chatJid}': 'main',
\`\`\``;
  } else if (normalizedCommand === 'update') {
    // Authorization check would go here
    const pendingPath = path.join(DATA_DIR, 'update-pending.json');
    fs.writeFileSync(
      pendingPath,
      JSON.stringify(
        {
          chatJid,
          timestamp: new Date().toISOString(),
          updateStartTime: Date.now(),
          sender: sender || '',
        },
        null,
        2,
      ),
    );

    const { spawn } = await import('child_process');
    const logPath = path.join(DATA_DIR, 'update.log');
    const logStream = fs.openSync(logPath, 'a');

    const child = spawn('npm', ['run', 'update'], {
      detached: true,
      stdio: ['ignore', logStream, logStream],
      cwd: process.cwd(),
    });

    child.unref();

    return 'Update in progress... The bot will restart shortly.';
  }

  return `Unknown command: ${command}`;
}

/**
 * Create and configure the Chat SDK bot
 */
export async function createChatSdkBot(): Promise<Chat> {
  // Create SQLite state adapter
  stateAdapter = createSQLiteState(path.join(DATA_DIR, 'nanoclaw.db'));
  await stateAdapter.connect();

  // Build adapters object - each platform is optional
  const adapters: Record<
    string,
    | ReturnType<typeof createDiscordAdapter>
    | ReturnType<typeof createSlackAdapter>
  > = {};

  // Configure Discord adapter if token is provided
  if (process.env.DISCORD_BOT_TOKEN) {
    adapters.discord = createDiscordAdapter({
      logger: new PinoLoggerAdapter(logger),
    });
  }

  // Configure Slack adapter if token is provided
  if (process.env.SLACK_BOT_TOKEN) {
    adapters.slack = createSlackAdapter({
      logger: new PinoLoggerAdapter(logger),
    });
  }

  // Check if any adapters are configured
  if (Object.keys(adapters).length === 0) {
    throw new Error(
      'No chat adapters configured. Please set DISCORD_BOT_TOKEN and/or SLACK_BOT_TOKEN in your environment.',
    );
  }

  // Create Chat SDK bot
  const bot = new Chat({
    userName: process.env.ASSISTANT_NAME ?? 'Andy'.toLowerCase(),
    adapters,
    state: stateAdapter,
    logger: new PinoLoggerAdapter(logger),
  });

  bot.onNewMention(async (thread, message) => {
    logger.debug(
      { threadId: thread.id, messageId: message.id },
      'incoming onNewMention',
    );

    const agent = await resolveAgentForJid(thread.id);

    if (!agent) {
      logger.info(
        { threadId: thread.id },
        'Channel not routed; ignoring mention',
      );
      return;
    }

    // Subscribe to thread for follow-up messages
    await thread.subscribe();

    // Add acknowledgement reaction
    await addAcknowledgement(thread, message.id);

    // Process attachments from Chat SDK message
    let content = message.text || '';
    let savedAttachments: InternalAttachment[] = [];

    if (message.attachments && message.attachments.length > 0) {
      logger.info(
        { threadId: thread.id, attachmentCount: message.attachments.length },
        'Processing attachments from mention',
      );

      const { savedAttachments: attachments, mediaNotes } =
        await processChatSdkAttachments(message.attachments);
      savedAttachments = attachments;

      // Append media notes to content
      if (mediaNotes.length > 0) {
        if (content) {
          content = `${content}\n\n${mediaNotes.join('\n')}`;
        } else {
          content = mediaNotes.join('\n');
        }
      }
    }

    // Store the message
    handleIncomingMessage(
      thread.id,
      message.id,
      message.author?.userId || 'unknown',
      message.author?.userName || 'Unknown',
      content,
      message.metadata?.dateSent?.toISOString() || new Date().toISOString(),
      savedAttachments,
    );

    // Run agent
    const sessionId = await ensureSessionForThread(thread.id);
    await runAgent(thread.id, agent, content, sessionId, thread, message.id);

    logger.info(
      { threadId: thread.id, messageCount: message.text?.length },
      'Processed new message in mentioned thread',
    );
  });

  // Handle subscribed messages (follow-ups in same thread)
  bot.onSubscribedMessage(async (thread, message) => {
    const agent = await resolveAgentForJid(thread.id);

    if (!agent) {
      return;
    }

    // Get content
    let content = message.text || '';

    // Process attachments from Chat SDK message
    let savedAttachments: InternalAttachment[] = [];

    if (message.attachments && message.attachments.length > 0) {
      logger.info(
        { threadId: thread.id, attachmentCount: message.attachments.length },
        'Processing attachments from subscribed message',
      );

      const { savedAttachments: attachments, mediaNotes } =
        await processChatSdkAttachments(message.attachments);
      savedAttachments = attachments;

      // Append media notes to content
      if (mediaNotes.length > 0) {
        if (content) {
          content = `${content}\n\n${mediaNotes.join('\n')}`;
        } else {
          content = mediaNotes.join('\n');
        }
      }
    }

    // Check for commands
    const trimmed = content.trim();
    if (trimmed.startsWith('/')) {
      const command = trimmed.slice(1).toLowerCase();
      if (['clear', 'status', 'chatid', 'update'].includes(command)) {
        const response = await executeCommand(
          thread.id,
          command,
          message.author?.userId,
        );
        await thread.post(response);
        return;
      }
    }

    // Add acknowledgement
    await addAcknowledgement(thread, message.id);

    // Store message
    handleIncomingMessage(
      thread.id,
      message.id,
      message.author?.userId || 'unknown',
      message.author?.userName || 'Unknown',
      content,
      message.metadata?.dateSent?.toISOString() || new Date().toISOString(),
      savedAttachments,
    );

    // Run agent
    const sessionId = await ensureSessionForThread(thread.id);
    await runAgent(thread.id, agent, content, sessionId, thread, message.id);

    logger.info(
      { threadId: thread.id, messageCount: message.text?.length },
      'Processed new message in subscribed thread',
    );
  });

  // Handle ALL messages in unsubscribed threads (catch-all)
  bot.onNewMessage(/.*/, async (thread, message) => {
    logger.debug(
      { threadId: thread.id, messageId: message.id },
      'incoming onNewMessage',
    );

    if (message.author.isMe) {
      logger.debug(
        { threadId: thread.id, messageId: message.id },
        'skipping message from me',
      );
      return;
    }

    if (message.isMention) {
      logger.info(
        { threadId: thread.id, messageId: message.id },
        'skipping, detected mention in new message',
      );

      return;
    }

    // Skip if already subscribed (onSubscribedMessage will handle it)
    if (await thread.isSubscribed()) {
      logger.info(
        { threadId: thread.id },
        'Skipping message - already subscribed',
      );
      return;
    }

    const agent = await resolveAgentForJid(thread.id);

    if (!agent) {
      logger.info(
        { threadId: thread.id },
        'Channel not routed; ignoring message',
      );
      return;
    }

    // Subscribe to this thread so future messages go to onSubscribedMessage
    await thread.subscribe();

    // Add acknowledgement reaction
    await addAcknowledgement(thread, message.id);

    // Process attachments from Chat SDK message
    let content = message.text || '';
    let savedAttachments: InternalAttachment[] = [];

    if (message.attachments && message.attachments.length > 0) {
      logger.info(
        { threadId: thread.id, attachmentCount: message.attachments.length },
        'Processing attachments from new message',
      );

      const { savedAttachments: attachments, mediaNotes } =
        await processChatSdkAttachments(message.attachments);
      savedAttachments = attachments;

      // Append media notes to content
      if (mediaNotes.length > 0) {
        if (content) {
          content = `${content}\n\n${mediaNotes.join('\n')}`;
        } else {
          content = mediaNotes.join('\n');
        }
      }
    }

    // Store the message
    handleIncomingMessage(
      thread.id,
      message.id,
      message.author?.userId || 'unknown',
      message.author?.userName || 'Unknown',
      content,
      message.metadata?.dateSent?.toISOString() || new Date().toISOString(),
      savedAttachments,
    );

    // Run agent
    const sessionId = await ensureSessionForThread(thread.id);

    await runAgent(thread.id, agent, content, sessionId, thread, message.id);

    logger.info(
      { threadId: thread.id, messageCount: message.text?.length },
      'Processed new message in unsubscribed thread',
    );
  });

  // Handle slash commands
  bot.onSlashCommand('clear', async ({ channel, user }) => {
    const response = await executeCommand(channel.id, 'clear', user.userId);
    await channel.post(response);
  });

  bot.onSlashCommand('status', async ({ channel, user }) => {
    const response = await executeCommand(channel.id, 'status', user.userId);
    await channel.post(response);
  });

  bot.onSlashCommand('chatid', async ({ channel, user }) => {
    const response = await executeCommand(channel.id, 'chatid', user.userId);
    await channel.post(response);
  });

  bot.onSlashCommand('update', async ({ channel, user }) => {
    const response = await executeCommand(channel.id, 'update', user.userId);
    await channel.post(response);
  });

  await bot.initialize();

  // Start Discord gateway listener if Discord is configured
  // Discord uses WebSocket gateway; Slack uses HTTP webhooks (handled by Chat SDK)
  if (process.env.DISCORD_BOT_TOKEN) {
    const discordAdapter = bot.getAdapter('discord');
    // Type guard: Discord adapter has startGatewayListener, Slack does not
    if ('startGatewayListener' in discordAdapter) {
      await discordAdapter.startGatewayListener(
        { waitUntil: (promise: Promise<unknown>) => promise },
        Infinity,
        undefined,
        undefined,
      );
      logger.info('Discord adapter started');
    }
  }

  // Slack is initialized via webhooks (no gateway listener needed)
  // The Chat SDK handles webhook routing automatically
  if (process.env.SLACK_BOT_TOKEN) {
    logger.info('Slack adapter initialized (webhook mode)');
  }

  // Store the bot instance for use by other modules
  botInstance = bot;

  return bot;
}

/**
 * Send a message to a specific thread ID (used by scheduler and other modules)
 * Automatically detects platform from thread ID format (e.g., discord:..., slack:...)
 */
export async function sendMessageToJid(
  threadId: string,
  text: string,
): Promise<void> {
  if (!botInstance) {
    logger.error({ threadId }, 'Cannot send message - bot not initialized');
    throw new Error('Bot not initialized');
  }

  try {
    // Parse platform from thread ID: discord:... or slack:... or teams:...
    const [platform] = threadId.split(':');

    if (!platform) {
      logger.error(
        { threadId },
        'Invalid thread ID format - no platform prefix',
      );
      throw new Error('Invalid thread ID format');
    }

    // Get the appropriate adapter
    const adapter = botInstance.getAdapter(platform);
    if (!adapter) {
      logger.error({ threadId, platform }, 'No adapter available for platform');
      throw new Error(`No adapter for platform: ${platform}`);
    }

    if (adapter.postMessage) {
      await adapter.postMessage(threadId, text);
      logger.info(
        { threadId, platform, text: text.slice(0, 50) },
        'Sent message via adapter',
      );
    } else {
      logger.error(
        { threadId, platform },
        'Adapter does not support postMessage',
      );
      throw new Error('Adapter method not available');
    }
  } catch (err) {
    logger.error(
      { threadId, err, text: text.slice(0, 50) },
      'Failed to send message to thread',
    );
    throw err;
  }
}
