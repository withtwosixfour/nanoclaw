import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  DISCORD_BOT_TOKEN,
  DISCORD_ONLY,
  IDLE_TIMEOUT,
  MAIN_AGENT_ID,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from './config.js';
import { DiscordChannel } from './channels/discord.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import {
  AgentOutput,
  AgentInput,
  AvailableGroup,
  createAgentRuntime,
} from './agent-runner/runtime.js';
import {
  getAllChats,
  getAllAgents,
  getAllSessions,
  getAllRoutes,
  deleteSession,
  getMessagesSince,
  getNewMessages,
  getNewMessagesAll,
  getRouterState,
  initDatabase,
  setAgent,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
  resolveAgentId,
  loadRoutesFromDb,
  getRouteJids,
  getSessionPath,
} from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Agent, Channel, NewMessage } from './types.js';
import { logger } from './logger.js';
import {
  clearSession,
  getOrCreateSessionId,
  getSessionLastTimestamp,
  getSessionMessageCount,
  getSessionTokenCount,
} from './agent-runner/session-store.js';
import { runMigration } from './migration.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
// Sessions now map JID -> sessionId
let sessions: Record<string, string> = {};
// Agents map agentId -> Agent definition
let agents: Record<string, Agent> = {};
let lastAgentTimestamp: Record<string, string> = {};
let lastCommandTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

let whatsapp: WhatsAppChannel;
const channels: Channel[] = [];
const queue = new GroupQueue();
const agentRuntime = createAgentRuntime({
  sendMessage: async (jid, text) => {
    const channel = findChannel(channels, jid);
    if (!channel) {
      throw new Error(`No channel for JID: ${jid}`);
    }
    await channel.sendMessage(jid, text);
  },
  registerAgent,
  getRegisteredAgents: () => agents,
});

queue.setPipeMessageFn(agentRuntime.pipeMessage);
queue.setCloseFn(agentRuntime.close);

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  const commandTs = getRouterState('last_command_timestamp');
  try {
    lastCommandTimestamp = commandTs ? JSON.parse(commandTs) : {};
  } catch {
    logger.warn('Corrupted last_command_timestamp in DB, resetting');
    lastCommandTimestamp = {};
  }

  // Load agents
  agents = getAllAgents();

  // Load sessions (new format: JID -> {agentId, sessionId})
  const sessionData = getAllSessions();
  sessions = {};
  for (const [jid, data] of Object.entries(sessionData)) {
    sessions[jid] = data.sessionId;
    // Note: agentId is stored in DB but we resolve it from routes at runtime
    // This ensures session state persists across restarts
  }

  logger.info(
    {
      agentCount: Object.keys(agents).length,
      sessionCount: Object.keys(sessions).length,
    },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
  setRouterState(
    'last_command_timestamp',
    JSON.stringify(lastCommandTimestamp),
  );
}

type CommandType = 'clear' | 'status';

function parseCommand(text: string): CommandType | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const normalized = trimmed.toLowerCase();
  if (normalized === '/clear') return 'clear';
  if (normalized === '/status') return 'status';
  return null;
}

function splitCommandMessages(
  messages: NewMessage[],
  chatJid: string,
): {
  commands: Array<{ message: NewMessage; command: CommandType }>;
  nonCommands: NewMessage[];
} {
  const commands: Array<{ message: NewMessage; command: CommandType }> = [];
  const nonCommands: NewMessage[] = [];
  const cutoff = lastCommandTimestamp[chatJid] || '';

  for (const message of messages) {
    const command = parseCommand(message.content);
    if (command) {
      if (!cutoff || message.timestamp > cutoff) {
        commands.push({ message, command });
      }
      continue;
    }
    nonCommands.push(message);
  }

  return { commands, nonCommands };
}

export async function executeCommand(
  chatJid: string,
  command: CommandType | string,
): Promise<string> {
  const agent = resolveAgentForJid(chatJid);
  if (!agent) {
    return `No agent configured for this channel. Please add a route in src/router.ts.`;
  }

  if (command === 'clear') {
    clearSession(chatJid);
    delete sessions[chatJid];
    deleteSession(chatJid);
    return 'Session cleared. New conversation will start on next message.';
  } else if (command === 'status') {
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
  }

  return 'Unknown command.';
}

async function handleCommandMessages(
  chatJid: string,
  agent: Agent,
  channel: Channel,
  commands: Array<{ message: NewMessage; command: CommandType }>,
): Promise<void> {
  if (commands.length === 0) return;

  for (const { message, command } of commands) {
    const response = await executeCommand(chatJid, command);
    await channel.sendMessage(chatJid, response);

    if (
      !lastCommandTimestamp[chatJid] ||
      message.timestamp > lastCommandTimestamp[chatJid]
    ) {
      lastCommandTimestamp[chatJid] = message.timestamp;
    }
  }

  saveState();
}

function registerAgent(id: string, agent: Agent): void {
  agents[id] = agent;
  setAgent(id, agent);

  // Create agent folder if needed
  const agentDir = path.join(DATA_DIR, '..', 'agents', agent.folder);
  fs.mkdirSync(path.join(agentDir, 'logs'), { recursive: true });

  logger.info(
    { id, name: agent.name, folder: agent.folder },
    'Agent registered',
  );
}

/**
 * Set registered groups/agents for testing.
 * @deprecated Use for tests only
 */
export function _setRegisteredGroups(newAgents: Record<string, Agent>): void {
  agents = newAgents;
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  // A JID is "registered" if it has a route in the DB cache
  const registeredJids = new Set(getRouteJids());

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setAgents(newAgents: Record<string, Agent>): void {
  agents = newAgents;
}

/**
 * Resolve agent for a JID using the DB-backed route cache.
 */
function resolveAgentForJid(jid: string): Agent | null {
  const agentId = resolveAgentId(jid);
  if (!agentId) return null;
  return agents[agentId] || null;
}

function ensureSessionForJid(chatJid: string): void {
  const agent = resolveAgentForJid(chatJid);
  if (!agent) return;
  const sessionDir = getSessionPath(chatJid);
  const sessionFilePath = path.join(sessionDir, 'session.json');
  const existingSessionId = sessions[chatJid];
  const sessionFileExists = fs.existsSync(sessionFilePath);
  if (existingSessionId && sessionFileExists) return;
  logger.info(
    {
      chatJid,
      agentId: agent.id,
      sessionDir,
      sessionFilePath,
      existingSessionId,
      sessionFileExists,
      cwd: process.cwd(),
    },
    'Ensuring session for routed JID',
  );
  try {
    let sessionId = existingSessionId;
    if (!sessionId) {
      sessionId = getOrCreateSessionId(chatJid, agent.id);
    } else if (!sessionFileExists) {
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        sessionFilePath,
        JSON.stringify({ sessionId, agentId: agent.id, jid: chatJid }, null, 2),
      );
    }
    getSessionMessageCount(chatJid, sessionId);
    const sessionFileNowExists = fs.existsSync(sessionFilePath);
    logger.info(
      { chatJid, sessionId, sessionFileExists: sessionFileNowExists },
      'Session ensured',
    );
    sessions[chatJid] = sessionId;
    setSession(chatJid, agent.id, sessionId);
  } catch (err) {
    logger.error({ chatJid, err }, 'Failed to ensure session');
  }
}

/**
 * Process all pending messages for a JID.
 * Called by the GroupQueue when it's this JID's turn.
 */
async function processJidMessages(chatJid: string): Promise<boolean> {
  const agent = resolveAgentForJid(chatJid);
  if (!agent) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
    return true;
  }

  const isMainAgent = agent.id === MAIN_AGENT_ID;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  const { commands, nonCommands } = splitCommandMessages(
    missedMessages,
    chatJid,
  );
  await handleCommandMessages(chatJid, agent, channel, commands);
  if (nonCommands.length === 0) return true;

  // For non-main agents, check if trigger is required and present
  if (!isMainAgent && agent.requiresTrigger !== false) {
    const hasTrigger = nonCommands.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(nonCommands);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] = nonCommands[nonCommands.length - 1].timestamp;
  saveState();

  logger.info(
    { agent: agent.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ agent: agent.name }, 'Idle timeout, closing agent run');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  // Track the final response to send at the end
  let finalResponseText = '';

  const output = await runAgent(agent, prompt, chatJid, async (result) => {
    // Streaming output callback — track the latest response but don't send yet
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ agent: agent.name }, `Agent output: ${raw.slice(0, 200)}`);
      // Store as the final response (overwrites previous steps)
      if (text) {
        finalResponseText = text;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  // Send only the final response after the agent run completes
  if (finalResponseText) {
    await channel.sendMessage(chatJid, finalResponseText);
    outputSentToUser = true;
  }

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { agent: agent.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { agent: agent.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  agent: Agent,
  prompt: string,
  chatJid: string,
  onOutput?: (output: AgentOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = agent.id === MAIN_AGENT_ID;
  // Get or create session for this JID
  const sessionId =
    sessions[chatJid] || getOrCreateSessionId(chatJid, agent.id);
  // Only save to DB if this is a new session (not already loaded from DB)
  if (!sessions[chatJid]) {
    sessions[chatJid] = sessionId;
    setSession(chatJid, agent.id, sessionId);
  }

  try {
    const output = await runAgentInput(
      {
        prompt,
        sessionId,
        agentId: agent.id,
        chatJid,
        isMain,
        modelProvider: agent.modelProvider,
        modelName: agent.modelName,
      },
      onOutput,
    );

    if (output.newSessionId) {
      sessions[chatJid] = output.newSessionId;
      setSession(chatJid, agent.id, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error({ agent: agent.name, error: output.error }, 'Agent error');
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ agent: agent.name, err }, 'Agent error');
    return 'error';
  }
}

async function runAgentInput(
  input: AgentInput,
  onOutput?: (output: AgentOutput) => Promise<void>,
): Promise<AgentOutput> {
  const wrappedOnOutput = onOutput
    ? async (output: AgentOutput) => {
        if (output.newSessionId) {
          sessions[input.chatJid] = output.newSessionId;
          // Get agent ID from routes
          const agentId = resolveAgentId(input.chatJid);
          if (agentId) {
            setSession(input.chatJid, agentId, output.newSessionId);
          }
        }
        await onOutput(output);
      }
    : undefined;

  const output = await agentRuntime.run(input, wrappedOnOutput);
  if (output.newSessionId) {
    sessions[input.chatJid] = output.newSessionId;
    const agentId = resolveAgentId(input.chatJid);
    if (agentId) {
      setSession(input.chatJid, agentId, output.newSessionId);
    }
  }
  return output;
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      // Get all JIDs that have routes
      const routedJids = getRouteJids();
      const hasWildcard = routedJids.some((jid) => jid.includes('*'));

      const { messages: rawMessages, newTimestamp } = hasWildcard
        ? getNewMessagesAll(lastTimestamp, ASSISTANT_NAME)
        : getNewMessages(routedJids, lastTimestamp, ASSISTANT_NAME);

      const messages = hasWildcard
        ? rawMessages.filter((msg) => resolveAgentId(msg.chat_jid))
        : rawMessages;

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by JID
        const messagesByJid = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByJid.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByJid.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, jidMessages] of messagesByJid) {
          const agent = resolveAgentForJid(chatJid);
          if (!agent) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            console.log(
              `Warning: no channel owns JID ${chatJid}, skipping messages`,
            );
            continue;
          }

          const { commands, nonCommands } = splitCommandMessages(
            jidMessages,
            chatJid,
          );
          await handleCommandMessages(chatJid, agent, channel, commands);
          if (nonCommands.length === 0) continue;

          const isMainAgent = agent.id === MAIN_AGENT_ID;
          const needsTrigger = !isMainAgent && agent.requiresTrigger !== false;

          // For non-main agents, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = nonCommands.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const pendingMessages =
            allPending.length > 0 ? allPending : nonCommands;
          const pendingSplit = splitCommandMessages(pendingMessages, chatJid);
          await handleCommandMessages(
            chatJid,
            agent,
            channel,
            pendingSplit.commands,
          );
          const messagesToSend = pendingSplit.nonCommands;
          if (messagesToSend.length === 0) continue;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active agent run',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the agent processes the piped message
            channel.setTyping?.(chatJid, true);
          } else {
            // No active run — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in routed JIDs.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const chatJid of getRouteJids()) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      const agent = resolveAgentForJid(chatJid);
      logger.info(
        { jid: chatJid, agent: agent?.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

async function main(): Promise<void> {
  initDatabase();
  logger.info('Database initialized');

  // Run migration after DB is ready (renames groups/ to agents/, moves .nanoclaw/ to sessions/)
  await runMigration();

  // Load routes from database into memory
  const dbRoutes = getAllRoutes();
  loadRoutesFromDb(dbRoutes);
  logger.info(
    { routeCount: Object.keys(dbRoutes).length },
    'Routes loaded from database',
  );

  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      storeMessage(msg);
      ensureSessionForJid(chatJid);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => ({}), // Deprecated, returns empty
    executeCommand,
  };

  // Create and connect channels
  if (DISCORD_BOT_TOKEN) {
    const discord = new DiscordChannel(DISCORD_BOT_TOKEN, channelOpts);
    channels.push(discord);
    await discord.connect();
  }

  if (!DISCORD_ONLY) {
    whatsapp = new WhatsAppChannel(channelOpts);
    channels.push(whatsapp);
    await whatsapp.connect();
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    agents: () => agents,
    getSessions: () => sessions,
    queue,
    runAgent: runAgentInput,
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        console.log(`Warning: no channel owns JID ${jid}, cannot send message`);
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  queue.setProcessMessagesFn(processJidMessages);
  recoverPendingMessages();
  startMessageLoop();
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
