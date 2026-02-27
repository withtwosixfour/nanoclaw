import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Chats table - core chat metadata
export const chats = sqliteTable(
  'chats',
  {
    jid: text('jid').primaryKey(),
    name: text('name'),
    lastMessageTime: text('last_message_time'),
    channel: text('channel'),
    isGroup: integer('is_group', { mode: 'boolean' }).default(false),
  },
  (table) => ({
    lastMessageTimeIdx: index('idx_chats_last_message_time').on(
      table.lastMessageTime,
    ),
  }),
);

// Messages table - message content
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').notNull(),
    chatJid: text('chat_jid')
      .notNull()
      .references(() => chats.jid),
    sender: text('sender').notNull(),
    senderName: text('sender_name'),
    content: text('content'),
    timestamp: text('timestamp').notNull(),
    isFromMe: integer('is_from_me', { mode: 'boolean' }).default(false),
    isBotMessage: integer('is_bot_message', { mode: 'boolean' }).default(false),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.id, table.chatJid] }),
    timestampIdx: index('idx_messages_timestamp').on(table.timestamp),
    chatJidIdx: index('idx_messages_chat_jid').on(table.chatJid),
  }),
);

// Attachments table - file metadata for messages
export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').notNull(),
    chatJid: text('chat_jid').notNull(),
    filename: text('filename').notNull(),
    path: text('path').notNull(),
    mimeType: text('mime_type').notNull(),
    size: integer('size').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    messageIdx: index('idx_attachments_message').on(
      table.messageId,
      table.chatJid,
    ),
  }),
);

// Agents table - agent definitions
export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    folder: text('folder').notNull().unique(),
    name: text('name').notNull(),
    triggerPattern: text('trigger_pattern').notNull(),
    addedAt: text('added_at').notNull(),
    requiresTrigger: integer('requires_trigger', { mode: 'boolean' }).default(
      true,
    ),
    modelProvider: text('model_provider').default('opencode-zen'),
    modelName: text('model_name').default('kimi-k2.5'),
    isMain: integer('is_main', { mode: 'boolean' }).default(false),
  },
  (table) => ({
    folderIdx: index('idx_agents_folder').on(table.folder),
  }),
);

// Sessions table - JID-to-session mappings
export const sessions = sqliteTable(
  'sessions',
  {
    jid: text('jid').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    sessionId: text('session_id').notNull(),
  },
  (table) => ({
    agentIdx: index('idx_sessions_agent').on(table.agentId),
  }),
);

// Routes table - thread-to-agent routing
export const routes = sqliteTable(
  'routes',
  {
    threadId: text('thread_id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    agentIdx: index('idx_routes_agent').on(table.agentId),
  }),
);

// Router state table - key-value state storage
export const routerState = sqliteTable('router_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// Scheduled tasks table - cron/interval task definitions
export const scheduledTasks = sqliteTable(
  'scheduled_tasks',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    chatJid: text('chat_jid').notNull(),
    threadId: text('thread_id'),
    prompt: text('prompt').notNull(),
    scheduleType: text('schedule_type').notNull(),
    scheduleValue: text('schedule_value').notNull(),
    contextMode: text('context_mode').default('isolated'),
    nextRun: text('next_run'),
    lastRun: text('last_run'),
    lastResult: text('last_result'),
    status: text('status').default('active'),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    nextRunIdx: index('idx_scheduled_tasks_next_run').on(table.nextRun),
    statusIdx: index('idx_scheduled_tasks_status').on(table.status),
    threadIdIdx: index('idx_scheduled_tasks_thread_id').on(table.threadId),
    agentIdx: index('idx_scheduled_tasks_agent').on(table.agentId),
  }),
);

// Task run logs table - execution history for tasks
export const taskRunLogs = sqliteTable(
  'task_run_logs',
  {
    id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
    taskId: text('task_id')
      .notNull()
      .references(() => scheduledTasks.id),
    runAt: text('run_at').notNull(),
    durationMs: integer('duration_ms').notNull(),
    status: text('status').notNull(),
    result: text('result'),
    error: text('error'),
  },
  (table) => ({
    taskRunIdx: index('idx_task_run_logs').on(table.taskId, table.runAt),
  }),
);

// Chat SDK tables - merged from chat-sdk-state-sqlite.ts

// Subscriptions table
export const chatSdkSubscriptions = sqliteTable('chat_sdk_subscriptions', {
  threadId: text('thread_id').primaryKey(),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
});

// Locks table
export const chatSdkLocks = sqliteTable(
  'chat_sdk_locks',
  {
    threadId: text('thread_id').primaryKey(),
    token: text('token').notNull(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    expiresIdx: index('idx_chat_sdk_locks_expires').on(table.expiresAt),
  }),
);

// Cache table
export const chatSdkCache = sqliteTable(
  'chat_sdk_cache',
  {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at'),
    createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    expiresIdx: index('idx_chat_sdk_cache_expires').on(table.expiresAt),
  }),
);
