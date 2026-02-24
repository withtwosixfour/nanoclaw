import { Chat, type Thread, type Message, type SlashCommandEvent } from 'chat';
import { createDiscordAdapter } from '@chat-adapter/discord';
import { createSQLiteState } from './chat-sdk-state-sqlite.js';
import {
  ASSISTANT_NAME,
  DISCORD_BOT_TOKEN,
  DATA_DIR,
  TRIGGER_PATTERN,
} from './config.js';
import { logger } from './logger.js';
import { resolveAgentId, loadRoutesFromDb } from './router.js';
import {
  storeMessage,
  storeAttachment,
  initDatabase,
  getAllRoutes,
  getAllAgents,
  getAllSessions,
  setAgent,
} from './db.js';
import {
  clearSession,
  getOrCreateSessionId,
  getSessionMessageCount,
  getSessionTokenCount,
  getSessionLastTimestamp,
} from './agent-runner/session-store.js';
import { createAgentRuntime, AgentInput } from './agent-runner/runtime.js';
import type { Agent, Attachment } from './types.js';
import path from 'path';
import fs from 'fs';

// State management
let sessions: Record<string, string> = {};
let agents: Record<string, Agent> = {};
let lastAgentTimestamp: Record<string, string> = {};
let lastCommandTimestamp: Record<string, string> = {};
let botInstance: Chat | null = null;

// Track which messages we're processing (for 👀 reactions)
const processingMessages = new Map<
  string,
  { messageId: string; timeout: NodeJS.Timeout }
>();

/**
 * Convert Chat SDK thread ID to our internal ID format
 * Chat SDK thread IDs are already in the correct format (e.g., "discord:guildId:channelId")
 * so we just return them as-is for routing and storage.
 */
function threadIdToJid(threadId: string): string {
  // Chat SDK thread IDs are already in the correct format
  // e.g., "discord:987654321:123456789"
  return threadId;
}

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
 * Get or create session for a JID
 */
function ensureSessionForJid(chatJid: string): string {
  if (!sessions[chatJid]) {
    const agentId = resolveAgentId(chatJid);
    if (agentId) {
      sessions[chatJid] = getOrCreateSessionId(chatJid, agentId);
    }
  }
  return sessions[chatJid];
}

/**
 * Resolve agent for a JID
 */
function resolveAgentForJid(chatJid: string): Agent | null {
  const agentId = resolveAgentId(chatJid);
  if (!agentId || !agents[agentId]) {
    return null;
  }
  return agents[agentId];
}

/**
 * Add 👀 reaction to show we're processing
 */
async function addAcknowledgement(
  thread: any,
  messageId: string,
  chatJid: string,
): Promise<void> {
  try {
    // React with 👀 using the thread's raw adapter if available
    // The Discord adapter exposes methods through the adapter property
    const adapter = (thread as any).adapter;
    if (adapter && typeof adapter.addReaction === 'function') {
      await adapter.addReaction(thread.id, messageId, '👀');
    }

    // Set safety timeout to auto-remove after 5 minutes
    const timeout = setTimeout(
      () => {
        clearAcknowledgement(thread, messageId, chatJid);
      },
      5 * 60 * 1000,
    );

    processingMessages.set(chatJid, { messageId, timeout });
  } catch (err) {
    logger.debug({ chatJid, err }, 'Failed to add acknowledgement reaction');
  }
}

/**
 * Clear 👀 reaction
 */
async function clearAcknowledgement(
  thread: any,
  messageId: string,
  chatJid: string,
): Promise<void> {
  const entry = processingMessages.get(chatJid);
  if (!entry) return;

  clearTimeout(entry.timeout);

  try {
    const adapter = (thread as any).adapter;
    if (adapter && typeof adapter.removeReaction === 'function') {
      await adapter.removeReaction(thread.id, messageId, '👀');
    }
  } catch (err) {
    logger.debug({ chatJid, err }, 'Failed to clear acknowledgement reaction');
  } finally {
    processingMessages.delete(chatJid);
  }
}

/**
 * Store message and metadata from Chat SDK
 */
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
  storeMessage({
    id: messageId,
    chat_jid: chatJid,
    sender,
    sender_name: senderName,
    content,
    timestamp,
    is_from_me: false,
  });

  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      storeAttachment(att, messageId, chatJid);
    }
  }

  ensureSessionForJid(chatJid);
}

/**
 * Run agent with input and stream response
 */
async function runAgent(
  chatJid: string,
  agent: Agent,
  prompt: string,
  sessionId: string,
  thread: any,
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
    await agentRuntime.run(input, async (output) => {
      if (output.status === 'success' && output.result) {
        // Clear acknowledgement before sending
        await clearAcknowledgement(thread, messageId, chatJid);

        // Send the response
        await thread.post(output.result);

        // Update timestamp
        lastAgentTimestamp[chatJid] = new Date().toISOString();
      } else if (output.status === 'error') {
        await clearAcknowledgement(thread, messageId, chatJid);
        logger.error({ chatJid, error: output.error }, 'Agent error');
        await thread.post(
          'Sorry, I encountered an error processing your request.',
        );
      }
    });
  } catch (err) {
    await clearAcknowledgement(thread, messageId, chatJid);
    logger.error({ chatJid, err }, 'Failed to run agent');
    await thread.post('Sorry, I encountered an error.');
  }
}

// Create agent runtime
const agentRuntime = createAgentRuntime({
  sendMessage: async (jid, text) => {
    // This is called by tools within the agent - we'll need to look up the thread
    // For now, this is a placeholder - in practice, tools shouldn't send messages directly
    logger.warn(
      { jid, text: text.slice(0, 50) },
      'Tool tried to send message - not implemented in Chat SDK mode',
    );
  },
  registerAgent: (jid, agent) => {
    agents[agent.id] = agent;
    setAgent(agent.id, agent);
  },
  getRegisteredAgents: () => agents,
});

/**
 * Execute slash commands
 */
async function executeCommand(
  chatJid: string,
  command: string,
  sender?: string,
): Promise<string> {
  const agent = resolveAgentForJid(chatJid);
  if (!agent) {
    return `No agent configured for this channel. Please add a route in src/router.ts.`;
  }

  const normalizedCommand = command.toLowerCase().replace(/^\//, '');

  if (normalizedCommand === 'clear') {
    clearSession(chatJid);
    delete sessions[chatJid];
    return 'Session cleared. New conversation will start on next message.';
  } else if (normalizedCommand === 'status') {
    const sessionId = sessions[chatJid];
    if (!sessionId) {
      return `Status: agent=${agent.id} session=none (no active session)`;
    }
    const modelProvider = agent.modelProvider || 'opencode-zen';
    const modelName = agent.modelName || 'kimi-k2.5';
    const messageCount = getSessionMessageCount(chatJid, sessionId);
    const tokenCount = getSessionTokenCount(chatJid, sessionId);
    const lastTs = getSessionLastTimestamp(chatJid, sessionId) || 'none';
    return `Status: agent=${agent.id} session=${sessionId} model=${modelProvider}/${modelName} messages=${messageCount} tokens=${tokenCount} last=${lastTs}`;
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
  // Initialize database
  initDatabase();
  logger.info('Database initialized');

  // Load routes
  const dbRoutes = getAllRoutes();
  loadRoutesFromDb(dbRoutes);
  logger.info(
    { routeCount: Object.keys(dbRoutes).length },
    'Routes loaded from database',
  );

  // Load state
  const sessionData = getAllSessions();
  for (const [jid, data] of Object.entries(sessionData)) {
    sessions[jid] = data.sessionId;
  }
  agents = getAllAgents();

  logger.info(
    {
      agentCount: Object.keys(agents).length,
      sessionCount: Object.keys(sessions).length,
    },
    'State loaded',
  );

  // Create SQLite state adapter
  const state = createSQLiteState(path.join(DATA_DIR, 'nanoclaw.db'));
  await state.connect();

  // Create Discord adapter
  const discordAdapter = createDiscordAdapter({
    botToken: DISCORD_BOT_TOKEN,
    // These would need to be configured - for now we'll log that they're needed
    publicKey: process.env.DISCORD_PUBLIC_KEY || '',
    applicationId: process.env.DISCORD_APPLICATION_ID || '',
  });

  // Create Chat SDK bot
  const bot = new Chat({
    userName: ASSISTANT_NAME.toLowerCase(),
    adapters: {
      discord: discordAdapter,
    },
    state,
    // logger: 'info', // Use default ConsoleLogger
  });

  // Handle new mentions (@bot)
  bot.onNewMention(async (thread, message) => {
    const chatJid = threadIdToJid(thread.id);
    const agent = resolveAgentForJid(chatJid);

    if (!agent) {
      logger.info(
        { chatJid, threadId: thread.id },
        'Channel not routed; ignoring mention',
      );
      return;
    }

    // Subscribe to thread for follow-up messages
    await thread.subscribe();

    // Get content and inject trigger if needed
    let content = message.text || '';

    // Check if bot was mentioned and inject trigger if needed
    // Chat SDK passes us the message already, but we need to ensure trigger is present
    if (!TRIGGER_PATTERN.test(content)) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    // Add acknowledgement reaction
    await addAcknowledgement(thread, message.id, chatJid);

    // Store the message
    handleIncomingMessage(
      chatJid,
      message.id,
      message.author?.userId || 'unknown',
      message.author?.userName || 'Unknown',
      content,
      message.metadata?.dateSent?.toISOString() || new Date().toISOString(),
      // TODO: Handle attachments
    );

    // Run agent
    const sessionId = ensureSessionForJid(chatJid);
    await runAgent(chatJid, agent, content, sessionId, thread, message.id);
  });

  // Handle subscribed messages (follow-ups in same thread)
  bot.onSubscribedMessage(async (thread, message) => {
    const chatJid = threadIdToJid(thread.id);
    const agent = resolveAgentForJid(chatJid);

    if (!agent) {
      return;
    }

    // Get content
    let content = message.text || '';

    // Check for commands
    const trimmed = content.trim();
    if (trimmed.startsWith('/')) {
      const command = trimmed.slice(1).toLowerCase();
      if (['clear', 'status', 'chatid', 'update'].includes(command)) {
        const response = await executeCommand(
          chatJid,
          command,
          message.author?.userId,
        );
        await thread.post(response);
        return;
      }
    }

    // Add acknowledgement
    await addAcknowledgement(thread, message.id, chatJid);

    // Store message
    handleIncomingMessage(
      chatJid,
      message.id,
      message.author?.userId || 'unknown',
      message.author?.userName || 'Unknown',
      content,
      message.metadata?.dateSent?.toISOString() || new Date().toISOString(),
    );

    // Run agent
    const sessionId = ensureSessionForJid(chatJid);
    await runAgent(chatJid, agent, content, sessionId, thread, message.id);
  });

  // Handle ALL messages in unsubscribed threads (catch-all)
  bot.onNewMessage(/.*/, async (thread, message) => {
    // Skip if already subscribed (onSubscribedMessage will handle it)
    if (await thread.isSubscribed()) return;

    const chatJid = threadIdToJid(thread.id);
    const agent = resolveAgentForJid(chatJid);

    if (!agent) {
      // Channel not routed - ignore
      return;
    }

    // Subscribe to this thread so future messages go to onSubscribedMessage
    await thread.subscribe();

    // Get content and inject trigger if needed
    let content = message.text || '';
    if (!TRIGGER_PATTERN.test(content)) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    // Add acknowledgement reaction
    await addAcknowledgement(thread, message.id, chatJid);

    // Store the message
    handleIncomingMessage(
      chatJid,
      message.id,
      message.author?.userId || 'unknown',
      message.author?.userName || 'Unknown',
      content,
      message.metadata?.dateSent?.toISOString() || new Date().toISOString(),
    );

    // Run agent
    const sessionId = ensureSessionForJid(chatJid);
    await runAgent(chatJid, agent, content, sessionId, thread, message.id);
  });

  // Handle slash commands
  bot.onSlashCommand('clear', async (event) => {
    const chatJid = threadIdToJid(event.channel.id);
    const response = await executeCommand(chatJid, 'clear', event.user.userId);
    await event.channel.post(response);
  });

  bot.onSlashCommand('status', async (event) => {
    const chatJid = threadIdToJid(event.channel.id);
    const response = await executeCommand(chatJid, 'status', event.user.userId);
    await event.channel.post(response);
  });

  bot.onSlashCommand('chatid', async (event) => {
    const chatJid = threadIdToJid(event.channel.id);
    const response = await executeCommand(chatJid, 'chatid', event.user.userId);
    await event.channel.post(response);
  });

  bot.onSlashCommand('update', async (event) => {
    const chatJid = threadIdToJid(event.channel.id);
    const response = await executeCommand(chatJid, 'update', event.user.userId);
    await event.channel.post(response);
  });

  // Store the bot instance for use by other modules
  botInstance = bot;

  return bot;
}

/**
 * Send a message to a specific JID (used by scheduler and other modules)
 * This opens a DM or finds the channel to send the message
 */
export async function sendMessageToJid(
  jid: string,
  text: string,
): Promise<void> {
  if (!botInstance) {
    logger.error({ jid }, 'Cannot send message - bot not initialized');
    throw new Error('Bot not initialized');
  }

  const threadId = jidToThreadId(jid);

  try {
    // Try to get the Discord adapter and send via DM or channel
    const discordAdapter = botInstance.getAdapter('discord');
    if (!discordAdapter) {
      logger.error({ jid }, 'Discord adapter not available');
      throw new Error('Discord adapter not available');
    }

    // For Discord, we can try to open a DM or post to a channel
    // The threadId format is: discord:{channelId}:{threadId} or just channelId
    // We need to parse it properly

    // Simple approach: post directly via the adapter's API
    // This requires the adapter to have a method to post to a specific channel
    const adapter = discordAdapter as any;

    if (adapter.postMessage) {
      await adapter.postMessage(threadId, text);
      logger.info({ jid, text: text.slice(0, 50) }, 'Sent message via adapter');
    } else {
      logger.error({ jid }, 'Adapter does not support postMessage');
      throw new Error('Adapter method not available');
    }
  } catch (err) {
    logger.error(
      { jid, err, text: text.slice(0, 50) },
      'Failed to send message to JID',
    );
    throw err;
  }
}

export { agents, sessions };
