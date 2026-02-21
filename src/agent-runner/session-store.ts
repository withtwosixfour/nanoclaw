import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { JSONValue, ModelMessage, ToolCallPart, ToolResultPart } from 'ai';

import { GROUPS_DIR } from '../config.js';

const dbs = new Map<string, Database.Database>();

function getStoreDir(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder, '.nanoclaw');
}

function getDb(groupFolder: string): Database.Database {
  const existing = dbs.get(groupFolder);
  if (existing) return existing;
  const storeDir = getStoreDir(groupFolder);
  const dbPath = path.join(storeDir, 'conversation.db');
  fs.mkdirSync(storeDir, { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
      content TEXT,
      tool_calls TEXT,
      tool_results TEXT,
      token_count INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_session ON conversation_history(group_folder, session_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_created ON conversation_history(created_at);
  `);
  dbs.set(groupFolder, db);
  return db;
}

function getSessionPath(groupFolder: string): string {
  return path.join(getStoreDir(groupFolder), 'session.json');
}

export function getOrCreateSessionId(groupFolder: string): string {
  const sessionPath = getSessionPath(groupFolder);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  if (fs.existsSync(sessionPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(sessionPath, 'utf-8')) as {
        sessionId?: string;
      };
      if (data.sessionId) return data.sessionId;
    } catch {
      // ignore corrupted session file
    }
  }

  const sessionId = randomUUID();
  fs.writeFileSync(
    sessionPath,
    JSON.stringify({ sessionId, groupFolder }, null, 2),
  );
  return sessionId;
}

export function loadMessages(
  groupFolder: string,
  sessionId: string,
): ModelMessage[] {
  const database = getDb(groupFolder);
  const rows = database
    .prepare(
      `SELECT role, content, tool_calls, tool_results
       FROM conversation_history
       WHERE group_folder = ? AND session_id = ?
       ORDER BY id ASC`,
    )
    .all(groupFolder, sessionId) as Array<{
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string | null;
    tool_calls: string | null;
    tool_results: string | null;
  }>;

  return rows.map((row) => deserializeMessage(row));
}

export function saveMessage(
  groupFolder: string,
  sessionId: string,
  message: ModelMessage,
  tokenCount?: number | null,
): void {
  const database = getDb(groupFolder);
  const { role, content, toolCalls, toolResults } = serializeMessage(message);
  database
    .prepare(
      `INSERT INTO conversation_history (group_folder, session_id, role, content, tool_calls, tool_results, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      groupFolder,
      sessionId,
      role,
      content,
      toolCalls,
      toolResults,
      tokenCount ?? null,
      new Date().toISOString(),
    );
}

export function getSessionTokenCount(
  groupFolder: string,
  sessionId: string,
): number {
  const database = getDb(groupFolder);
  const row = database
    .prepare(
      `SELECT SUM(token_count) as total
       FROM conversation_history
       WHERE session_id = ? AND token_count IS NOT NULL`,
    )
    .get(sessionId) as { total: number | null } | undefined;
  return row?.total ?? 0;
}

export function replaceSessionMessages(
  groupFolder: string,
  sessionId: string,
  messages: ModelMessage[],
): void {
  const database = getDb(groupFolder);
  const deleteStmt = database.prepare(
    `DELETE FROM conversation_history WHERE group_folder = ? AND session_id = ?`,
  );
  const insertStmt = database.prepare(
    `INSERT INTO conversation_history (group_folder, session_id, role, content, tool_calls, tool_results, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const now = new Date().toISOString();
  const insertMany = database.transaction(() => {
    deleteStmt.run(groupFolder, sessionId);
    for (const message of messages) {
      const { role, content, toolCalls, toolResults } =
        serializeMessage(message);
      insertStmt.run(
        groupFolder,
        sessionId,
        role,
        content,
        toolCalls,
        toolResults,
        null,
        now,
      );
    }
  });

  insertMany();
}

function serializeMessage(message: ModelMessage): {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  toolCalls: string | null;
  toolResults: string | null;
} {
  const role = message.role as 'user' | 'assistant' | 'system' | 'tool';
  const content = extractContentText(message);
  const toolCalls =
    role === 'assistant' && Array.isArray(message.content)
      ? serializeToolCalls(message.content)
      : null;
  const toolResults =
    role === 'tool' ? JSON.stringify(message.content ?? []) : null;

  return {
    role,
    content,
    toolCalls,
    toolResults,
  };
}

function deserializeMessage(row: {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  tool_calls: string | null;
  tool_results: string | null;
}): ModelMessage {
  if (row.role === 'tool') {
    const toolResults = normalizeToolResults(row.tool_results, row.content);
    return {
      role: 'tool',
      content: toolResults,
    };
  }

  const message: ModelMessage = {
    role: row.role,
    content: row.content || '',
  };

  if (row.tool_calls) {
    (message as { toolCalls?: unknown }).toolCalls = JSON.parse(row.tool_calls);
  }

  return message;
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
          return toolOutputToText(part.output);
        }
        return '';
      })
      .join('')
      .trim();
  }
  return String(content);
}

function serializeToolCalls(parts: Array<unknown>): string {
  const toolCalls = parts.filter(isToolCallPart).map((part) => ({
    toolName: part.toolName,
    toolCallId: part.toolCallId,
    input: part.input,
  }));
  return JSON.stringify(toolCalls);
}

function normalizeToolResults(
  toolResults: string | null,
  content: string | null,
): ToolResultPart[] {
  if (!toolResults) return [];
  try {
    return JSON.parse(toolResults) as ToolResultPart[];
  } catch {
    if (!content) return [];
    const fallback = {
      type: 'tool-result',
      toolName: 'unknown',
      toolCallId: 'unknown',
      output: content as unknown,
    } as unknown as ToolResultPart;
    return [fallback];
  }
}

function toolOutputToText(output: JSONValue | unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output ?? '');
  }
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
