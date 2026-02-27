import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

// Conversation history table - for per-JID session databases
export const conversationHistory = sqliteTable(
  'conversation_history',
  {
    id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    role: text('role').notNull(), // 'user', 'assistant', 'system', 'tool'
    content: text('content'),
    toolCalls: text('tool_calls'),
    toolResults: text('tool_results'),
    tokenCount: integer('token_count'),
    createdAt: text('created_at').notNull(),
    // Compaction columns
    isCompacted: integer('is_compacted', { mode: 'boolean' }).default(false),
    compactedAt: text('compacted_at'),
    isCompactedSummary: integer('is_compacted_summary', {
      mode: 'boolean',
    }).default(false),
    // Provider and model info for context
    provider: text('provider'),
    model: text('model'),
  },
  (table) => ({
    sessionIdx: index('idx_conversation_session').on(table.sessionId),
    createdAtIdx: index('idx_conversation_created').on(table.createdAt),
    compactedIdx: index('idx_conversation_compacted').on(
      table.sessionId,
      table.isCompacted,
    ),
  }),
);
