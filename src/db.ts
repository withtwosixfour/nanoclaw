import {
  eq,
  and,
  inArray,
  desc,
  asc,
  sql,
  gte,
  lte,
  isNull,
  not,
  like,
} from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import { db } from './db/main/client';
import * as schema from './db/main/schema';
import { ASSISTANT_NAME, DATA_DIR } from './config';
import {
  Agent,
  Attachment,
  NewMessage,
  ScheduledTask,
  TaskRunLog,
} from './types';

// Re-export schema for use in other modules
export { schema };

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.insert(schema.chats)
      .values({
        jid: chatJid,
        name,
        lastMessageTime: timestamp,
        channel: ch,
        isGroup: group,
      })
      .onConflictDoUpdate({
        target: schema.chats.jid,
        set: {
          name,
          lastMessageTime: sql`MAX(${schema.chats.lastMessageTime}, ${timestamp})`,
          channel: sql`COALESCE(${ch}, ${schema.chats.channel})`,
          isGroup: sql`COALESCE(${group}, ${schema.chats.isGroup})`,
        },
      })
      .run();
  } else {
    // Update timestamp only, preserve existing name if any
    db.insert(schema.chats)
      .values({
        jid: chatJid,
        name: chatJid,
        lastMessageTime: timestamp,
        channel: ch,
        isGroup: group,
      })
      .onConflictDoUpdate({
        target: schema.chats.jid,
        set: {
          lastMessageTime: sql`MAX(${schema.chats.lastMessageTime}, ${timestamp})`,
          channel: sql`COALESCE(${ch}, ${schema.chats.channel})`,
          isGroup: sql`COALESCE(${group}, ${schema.chats.isGroup})`,
        },
      })
      .run();
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.insert(schema.chats)
    .values({
      jid: chatJid,
      name,
      lastMessageTime: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: schema.chats.jid,
      set: { name },
    })
    .run();
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export async function getAllChats(): Promise<ChatInfo[]> {
  const rows = await db
    .select({
      jid: schema.chats.jid,
      name: schema.chats.name,
      last_message_time: schema.chats.lastMessageTime,
      channel: schema.chats.channel,
      is_group: sql<number>`CASE WHEN ${schema.chats.isGroup} = 1 THEN 1 ELSE 0 END`,
    })
    .from(schema.chats)
    .orderBy(desc(schema.chats.lastMessageTime))
    .all();

  return rows.map((row) => ({
    jid: row.jid,
    name: row.name ?? '',
    last_message_time: row.last_message_time ?? '',
    channel: row.channel ?? '',
    is_group: row.is_group,
  }));
}

/**
 * Get timestamp of last group metadata sync.
 */
export async function getLastGroupSync(): Promise<string | null> {
  const row = await db
    .select({ last_message_time: schema.chats.lastMessageTime })
    .from(schema.chats)
    .where(eq(schema.chats.jid, '__group_sync__'))
    .get();
  return row?.last_message_time ?? null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.insert(schema.chats)
    .values({
      jid: '__group_sync__',
      name: '__group_sync__',
      lastMessageTime: now,
    })
    .onConflictDoUpdate({
      target: schema.chats.jid,
      set: { lastMessageTime: now },
    })
    .run();
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.insert(schema.messages)
    .values({
      id: msg.id,
      chatJid: msg.chat_jid,
      sender: msg.sender,
      senderName: msg.sender_name,
      content: msg.content,
      timestamp: msg.timestamp,
      isFromMe: msg.is_from_me,
      isBotMessage: msg.is_bot_message,
    })
    .onConflictDoUpdate({
      target: [schema.messages.id, schema.messages.chatJid],
      set: {
        sender: msg.sender,
        senderName: msg.sender_name,
        content: msg.content,
        timestamp: msg.timestamp,
        isFromMe: msg.is_from_me,
        isBotMessage: msg.is_bot_message,
      },
    })
    .run();
}

/**
 * Store a message directly (for non-WhatsApp channels that don't use Baileys proto).
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.insert(schema.messages)
    .values({
      id: msg.id,
      chatJid: msg.chat_jid,
      sender: msg.sender,
      senderName: msg.sender_name,
      content: msg.content,
      timestamp: msg.timestamp,
      isFromMe: msg.is_from_me,
      isBotMessage: msg.is_bot_message ?? false,
    })
    .onConflictDoUpdate({
      target: [schema.messages.id, schema.messages.chatJid],
      set: {
        sender: msg.sender,
        senderName: msg.sender_name,
        content: msg.content,
        timestamp: msg.timestamp,
        isFromMe: msg.is_from_me,
        isBotMessage: msg.is_bot_message ?? false,
      },
    })
    .run();
}

export async function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
): Promise<{ messages: NewMessage[]; newTimestamp: string }> {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const rows = await db
    .select({
      id: schema.messages.id,
      chat_jid: schema.messages.chatJid,
      sender: schema.messages.sender,
      sender_name: schema.messages.senderName,
      content: schema.messages.content,
      timestamp: schema.messages.timestamp,
      is_from_me: schema.messages.isFromMe,
      is_bot_message: schema.messages.isBotMessage,
    })
    .from(schema.messages)
    .where(
      and(
        gte(schema.messages.timestamp, lastTimestamp),
        inArray(schema.messages.chatJid, jids),
        eq(schema.messages.isBotMessage, false),
        not(like(schema.messages.content, `${botPrefix}:%`)),
      ),
    )
    .orderBy(asc(schema.messages.timestamp))
    .all();

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return {
    messages: rows.map((row) => ({
      id: row.id,
      chat_jid: row.chat_jid,
      sender: row.sender,
      sender_name: row.sender_name ?? '',
      content: row.content ?? '',
      timestamp: row.timestamp,
      is_from_me: row.is_from_me ?? false,
      is_bot_message: row.is_bot_message ?? false,
    })),
    newTimestamp,
  };
}

export async function getNewMessagesAll(
  lastTimestamp: string,
  botPrefix: string,
): Promise<{ messages: NewMessage[]; newTimestamp: string }> {
  const rows = await db
    .select({
      id: schema.messages.id,
      chat_jid: schema.messages.chatJid,
      sender: schema.messages.sender,
      sender_name: schema.messages.senderName,
      content: schema.messages.content,
      timestamp: schema.messages.timestamp,
      is_from_me: schema.messages.isFromMe,
      is_bot_message: schema.messages.isBotMessage,
    })
    .from(schema.messages)
    .where(
      and(
        gte(schema.messages.timestamp, lastTimestamp),
        eq(schema.messages.isBotMessage, false),
        not(like(schema.messages.content, `${botPrefix}:%`)),
      ),
    )
    .orderBy(asc(schema.messages.timestamp))
    .all();

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return {
    messages: rows.map((row) => ({
      id: row.id,
      chat_jid: row.chat_jid,
      sender: row.sender,
      sender_name: row.sender_name ?? '',
      content: row.content ?? '',
      timestamp: row.timestamp,
      is_from_me: row.is_from_me ?? false,
      is_bot_message: row.is_bot_message ?? false,
    })),
    newTimestamp,
  };
}

export async function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
): Promise<NewMessage[]> {
  const rows = await db
    .select({
      id: schema.messages.id,
      chat_jid: schema.messages.chatJid,
      sender: schema.messages.sender,
      sender_name: schema.messages.senderName,
      content: schema.messages.content,
      timestamp: schema.messages.timestamp,
      is_from_me: schema.messages.isFromMe,
      is_bot_message: schema.messages.isBotMessage,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.chatJid, chatJid),
        gte(schema.messages.timestamp, sinceTimestamp),
        eq(schema.messages.isBotMessage, false),
        not(like(schema.messages.content, `${botPrefix}:%`)),
      ),
    )
    .orderBy(asc(schema.messages.timestamp))
    .all();

  return rows.map((row) => ({
    id: row.id,
    chat_jid: row.chat_jid,
    sender: row.sender,
    sender_name: row.sender_name ?? '',
    content: row.content ?? '',
    timestamp: row.timestamp,
    is_from_me: row.is_from_me ?? false,
    is_bot_message: row.is_bot_message ?? false,
  }));
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.insert(schema.scheduledTasks)
    .values({
      id: task.id,
      agentId: task.agent_id,
      chatJid: task.chat_jid,
      threadId: task.thread_id ?? null,
      prompt: task.prompt,
      scheduleType: task.schedule_type,
      scheduleValue: task.schedule_value,
      contextMode: task.context_mode ?? 'isolated',
      nextRun: task.next_run,
      lastRun: null,
      lastResult: null,
      status: task.status,
      createdAt: task.created_at,
    })
    .run();
}

export async function getTaskById(
  id: string,
): Promise<ScheduledTask | undefined> {
  const row = await db
    .select()
    .from(schema.scheduledTasks)
    .where(eq(schema.scheduledTasks.id, id))
    .get();

  if (!row) return undefined;

  return {
    id: row.id,
    agent_id: row.agentId,
    chat_jid: row.chatJid,
    thread_id: row.threadId ?? undefined,
    prompt: row.prompt,
    schedule_type: row.scheduleType as 'cron' | 'interval' | 'once',
    schedule_value: row.scheduleValue,
    context_mode: (row.contextMode ?? 'isolated') as 'group' | 'isolated',
    next_run: row.nextRun ?? null,
    last_run: row.lastRun ?? null,
    last_result: row.lastResult ?? null,
    status: row.status as 'active' | 'paused' | 'completed',
    created_at: row.createdAt,
  };
}

export async function getTasksForAgent(
  agentId: string,
): Promise<ScheduledTask[]> {
  const rows = await db
    .select()
    .from(schema.scheduledTasks)
    .where(eq(schema.scheduledTasks.agentId, agentId))
    .orderBy(desc(schema.scheduledTasks.createdAt))
    .all();

  return rows.map((row) => ({
    id: row.id,
    agent_id: row.agentId,
    chat_jid: row.chatJid,
    thread_id: row.threadId ?? undefined,
    prompt: row.prompt,
    schedule_type: row.scheduleType as 'cron' | 'interval' | 'once',
    schedule_value: row.scheduleValue,
    context_mode: (row.contextMode ?? 'isolated') as 'group' | 'isolated',
    next_run: row.nextRun ?? null,
    last_run: row.lastRun ?? null,
    last_result: row.lastResult ?? null,
    status: row.status as 'active' | 'paused' | 'completed',
    created_at: row.createdAt,
  }));
}

export async function getAllTasks(): Promise<ScheduledTask[]> {
  const rows = await db
    .select()
    .from(schema.scheduledTasks)
    .orderBy(desc(schema.scheduledTasks.createdAt))
    .all();

  return rows.map((row) => ({
    id: row.id,
    agent_id: row.agentId,
    chat_jid: row.chatJid,
    thread_id: row.threadId ?? undefined,
    prompt: row.prompt,
    schedule_type: row.scheduleType as 'cron' | 'interval' | 'once',
    schedule_value: row.scheduleValue,
    context_mode: (row.contextMode ?? 'isolated') as 'group' | 'isolated',
    next_run: row.nextRun ?? null,
    last_run: row.lastRun ?? null,
    last_result: row.lastResult ?? null,
    status: row.status as 'active' | 'paused' | 'completed',
    created_at: row.createdAt,
  }));
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const setValues: Partial<typeof schema.scheduledTasks.$inferInsert> = {};

  if (updates.prompt !== undefined) setValues.prompt = updates.prompt;
  if (updates.schedule_type !== undefined)
    setValues.scheduleType = updates.schedule_type;
  if (updates.schedule_value !== undefined)
    setValues.scheduleValue = updates.schedule_value;
  if (updates.next_run !== undefined) setValues.nextRun = updates.next_run;
  if (updates.status !== undefined) setValues.status = updates.status;

  if (Object.keys(setValues).length === 0) return;

  db.update(schema.scheduledTasks)
    .set(setValues)
    .where(eq(schema.scheduledTasks.id, id))
    .run();
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.delete(schema.taskRunLogs).where(eq(schema.taskRunLogs.taskId, id)).run();

  db.delete(schema.scheduledTasks)
    .where(eq(schema.scheduledTasks.id, id))
    .run();
}

export async function getDueTasks(): Promise<ScheduledTask[]> {
  const now = new Date().toISOString();

  const rows = await db
    .select()
    .from(schema.scheduledTasks)
    .where(
      and(
        eq(schema.scheduledTasks.status, 'active'),
        not(isNull(schema.scheduledTasks.nextRun)),
        lte(schema.scheduledTasks.nextRun, now),
      ),
    )
    .orderBy(asc(schema.scheduledTasks.nextRun))
    .all();

  return rows.map((row) => ({
    id: row.id,
    agent_id: row.agentId,
    chat_jid: row.chatJid,
    thread_id: row.threadId ?? undefined,
    prompt: row.prompt,
    schedule_type: row.scheduleType as 'cron' | 'interval' | 'once',
    schedule_value: row.scheduleValue,
    context_mode: (row.contextMode ?? 'isolated') as 'group' | 'isolated',
    next_run: row.nextRun ?? null,
    last_run: row.lastRun ?? null,
    last_result: row.lastResult ?? null,
    status: row.status as 'active' | 'paused' | 'completed',
    created_at: row.createdAt,
  }));
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();

  db.update(schema.scheduledTasks)
    .set({
      nextRun: nextRun ?? undefined,
      lastRun: now,
      lastResult,
      status: nextRun === null ? 'completed' : 'active',
    })
    .where(eq(schema.scheduledTasks.id, id))
    .run();
}

export function logTaskRun(log: TaskRunLog): void {
  db.insert(schema.taskRunLogs)
    .values({
      taskId: log.task_id,
      runAt: log.run_at,
      durationMs: log.duration_ms,
      status: log.status,
      result: log.result ?? null,
      error: log.error ?? null,
    })
    .run();
}

// --- Router state accessors ---

export async function getRouterState(key: string): Promise<string | undefined> {
  const row = await db
    .select({ value: schema.routerState.value })
    .from(schema.routerState)
    .where(eq(schema.routerState.key, key))
    .get();
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.insert(schema.routerState)
    .values({ key, value })
    .onConflictDoUpdate({
      target: schema.routerState.key,
      set: { value },
    })
    .run();
}

// --- Session accessors (JID-based) ---

export async function getSession(
  jid: string,
): Promise<{ agentId: string; sessionId: string } | undefined> {
  const row = await db
    .select({
      agent_id: schema.sessions.agentId,
      session_id: schema.sessions.sessionId,
    })
    .from(schema.sessions)
    .where(eq(schema.sessions.jid, jid))
    .get();

  if (!row) return undefined;
  return { agentId: row.agent_id, sessionId: row.session_id };
}

export function setSession(
  jid: string,
  agentId: string,
  sessionId: string,
): void {
  db.insert(schema.sessions)
    .values({ jid, agentId, sessionId })
    .onConflictDoUpdate({
      target: schema.sessions.jid,
      set: { agentId, sessionId },
    })
    .run();
}

export function deleteSession(jid: string): void {
  db.delete(schema.sessions).where(eq(schema.sessions.jid, jid)).run();
}

export async function getAllSessions(): Promise<
  Record<string, { agentId: string; sessionId: string }>
> {
  const rows = await db
    .select({
      jid: schema.sessions.jid,
      agent_id: schema.sessions.agentId,
      session_id: schema.sessions.sessionId,
    })
    .from(schema.sessions)
    .all();

  const result: Record<string, { agentId: string; sessionId: string }> = {};
  for (const row of rows) {
    result[row.jid] = { agentId: row.agent_id, sessionId: row.session_id };
  }
  return result;
}

// --- Agent accessors (replacing registered_groups) ---

export async function getAgent(id: string): Promise<Agent | undefined> {
  const row = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, id))
    .get();

  if (!row) return undefined;

  return {
    id: row.id,
    folder: row.folder,
    name: row.name,
    trigger: row.triggerPattern,
    added_at: row.addedAt,
    requiresTrigger: row.requiresTrigger ?? undefined,
    modelProvider: row.modelProvider ?? undefined,
    modelName: row.modelName ?? undefined,
    isMain: row.id === 'main' ? true : (row.isMain ?? undefined),
  };
}

export function setAgent(id: string, agent: Agent): void {
  db.insert(schema.agents)
    .values({
      id,
      folder: agent.folder,
      name: agent.name,
      triggerPattern: agent.trigger,
      addedAt: agent.added_at,
      requiresTrigger:
        agent.requiresTrigger === undefined ? true : agent.requiresTrigger,
      modelProvider: agent.modelProvider ?? 'google-vertex',
      modelName: agent.modelName ?? 'claude-sonnet-4-6',
      isMain: agent.isMain === undefined ? false : agent.isMain,
    })
    .onConflictDoUpdate({
      target: schema.agents.id,
      set: {
        folder: agent.folder,
        name: agent.name,
        triggerPattern: agent.trigger,
        addedAt: agent.added_at,
        requiresTrigger:
          agent.requiresTrigger === undefined ? true : agent.requiresTrigger,
        modelProvider: agent.modelProvider ?? 'google-vertex',
        modelName: agent.modelName ?? 'claude-sonnet-4-6',
        isMain: agent.isMain === undefined ? false : agent.isMain,
      },
    })
    .run();
}

export async function getAllAgents(): Promise<Record<string, Agent>> {
  const rows = await db.select().from(schema.agents).all();

  const result: Record<string, Agent> = {};
  for (const row of rows) {
    result[row.id] = {
      id: row.id,
      folder: row.folder,
      name: row.name,
      trigger: row.triggerPattern,
      added_at: row.addedAt,
      requiresTrigger: row.requiresTrigger ?? undefined,
      modelProvider: row.modelProvider ?? undefined,
      modelName: row.modelName ?? undefined,
      isMain: row.id === 'main' ? true : (row.isMain ?? undefined),
    };
  }
  return result;
}

// --- Routes accessors ---

export async function getRoute(jid: string): Promise<string | undefined> {
  const row = await db
    .select({ agent_id: schema.routes.agentId })
    .from(schema.routes)
    .where(eq(schema.routes.threadId, jid))
    .get();
  return row?.agent_id;
}

export function setRoute(threadId: string, agentId: string): void {
  db.insert(schema.routes)
    .values({
      threadId,
      agentId,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: schema.routes.threadId,
      set: { agentId, createdAt: new Date().toISOString() },
    })
    .run();
}

export function deleteRoute(threadId: string): void {
  db.delete(schema.routes).where(eq(schema.routes.threadId, threadId)).run();
}

export async function getAllRoutes(): Promise<Record<string, string>> {
  const rows = await db
    .select({
      thread_id: schema.routes.threadId,
      agent_id: schema.routes.agentId,
    })
    .from(schema.routes)
    .all();

  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.thread_id] = row.agent_id;
  }
  return result;
}

// --- Legacy migration helpers (for backward compatibility) ---

export async function getAllRegisteredGroups(): Promise<Record<string, Agent>> {
  // Alias for getAllAgents during migration
  return await getAllAgents();
}

export function setRegisteredGroup(jid: string, group: Agent): void {
  // Store as agent with id = folder
  setAgent(group.folder, { ...group, id: group.folder });
}

export async function getAllRegisteredGroupsLegacy(): Promise<
  Record<string, Agent & { jid: string }>
> {
  // For migration purposes - return agents with their JIDs
  const agents = await getAllAgents();
  const result: Record<string, Agent & { jid: string }> = {};
  for (const [id, agent] of Object.entries(agents)) {
    result[id] = { ...agent, jid: id };
  }
  return result;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json (legacy format: folder -> sessionId)
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    // Will be migrated later during agent/session migration
    setRouterState('legacy_sessions', JSON.stringify(sessions));
  }

  // Migrate registered_groups.json (legacy format: jid -> group)
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    Agent
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      // Store with folder as the agent id
      setAgent(group.folder, { ...group, id: group.folder });
    }
  }
}

// --- Attachment accessors ---

export function storeAttachment(
  attachment: Attachment,
  messageId: string,
  chatJid: string,
): void {
  db.insert(schema.attachments)
    .values({
      id: attachment.id,
      messageId,
      chatJid,
      filename: attachment.filename,
      path: attachment.path,
      mimeType: attachment.mimeType,
      size: attachment.size,
      createdAt: attachment.createdAt,
    })
    .run();
}

export async function getAttachmentsForMessage(
  messageId: string,
  chatJid: string,
): Promise<Attachment[]> {
  const rows = await db
    .select({
      id: schema.attachments.id,
      filename: schema.attachments.filename,
      path: schema.attachments.path,
      mimeType: schema.attachments.mimeType,
      size: schema.attachments.size,
      createdAt: schema.attachments.createdAt,
    })
    .from(schema.attachments)
    .where(
      and(
        eq(schema.attachments.messageId, messageId),
        eq(schema.attachments.chatJid, chatJid),
      ),
    )
    .all();

  return rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    path: row.path,
    mimeType: row.mimeType,
    size: row.size,
    createdAt: row.createdAt,
  }));
}
