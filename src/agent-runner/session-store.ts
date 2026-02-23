import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { JSONValue, ModelMessage, ToolCallPart, ToolResultPart } from 'ai';

import { SESSIONS_DIR } from '../config.js';
import { getSessionPath } from '../router.js';
import { logger } from '../logger.js';

const dbs = new Map<string, Database.Database>();

function getSessionDbPath(jid: string): string {
  const sessionDir = getSessionPath(jid);
  return path.join(sessionDir, 'conversation.db');
}

function getDb(jid: string): Database.Database {
  const existing = dbs.get(jid);
  if (existing) return existing;
  const dbPath = getSessionDbPath(jid);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
      content TEXT,
      tool_calls TEXT,
      tool_results TEXT,
      token_count INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_session ON conversation_history(session_id);
    CREATE INDEX IF NOT EXISTS idx_conversation_created ON conversation_history(created_at);
  `);
  dbs.set(jid, db);
  return db;
}

function getSessionFilePath(jid: string): string {
  const sessionDir = getSessionPath(jid);
  return path.join(sessionDir, 'session.json');
}

export function clearSession(jid: string): void {
  const sessionFilePath = getSessionFilePath(jid);
  try {
    fs.unlinkSync(sessionFilePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  // Close the database connection before deleting the file
  const db = dbs.get(jid);
  if (db) {
    try {
      db.close();
    } catch (err) {
      logger?.warn?.(
        { jid, err },
        'Error closing database connection during clear',
      );
    }
    dbs.delete(jid);
  }

  // Also clear the conversation history from the database
  const dbPath = getSessionDbPath(jid);
  if (fs.existsSync(dbPath)) {
    try {
      fs.unlinkSync(dbPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }
}

export function getOrCreateSessionId(jid: string, agentId: string): string {
  const sessionFilePath = getSessionFilePath(jid);
  fs.mkdirSync(path.dirname(sessionFilePath), { recursive: true });
  if (fs.existsSync(sessionFilePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(sessionFilePath, 'utf-8')) as {
        sessionId?: string;
        agentId?: string;
      };
      if (data.sessionId) {
        // If agent changed, we should start a new session
        if (data.agentId === agentId) {
          return data.sessionId;
        }
      }
    } catch {
      // ignore corrupted session file
    }
  }

  const sessionId = randomUUID();
  fs.writeFileSync(
    sessionFilePath,
    JSON.stringify({ sessionId, agentId, jid }, null, 2),
  );
  return sessionId;
}

export function loadMessages(jid: string, sessionId: string): ModelMessage[] {
  const database = getDb(jid);
  const rows = database
    .prepare(
      `SELECT role, content, tool_calls, tool_results
       FROM conversation_history
       WHERE session_id = ?
       ORDER BY id ASC`,
    )
    .all(sessionId) as Array<{
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string | null;
    tool_calls: string | null;
    tool_results: string | null;
  }>;

  return rows.map((row) => deserializeMessage(row));
}

export function saveMessage(
  jid: string,
  sessionId: string,
  message: ModelMessage,
  tokenCount?: number | null,
): void {
  const database = getDb(jid);
  const { role, content, toolCalls, toolResults } = serializeMessage(message);
  database
    .prepare(
      `INSERT INTO conversation_history (session_id, role, content, tool_calls, tool_results, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      role,
      content,
      toolCalls,
      toolResults,
      tokenCount ?? null,
      new Date().toISOString(),
    );
}

export function getSessionTokenCount(jid: string, sessionId: string): number {
  const database = getDb(jid);
  const row = database
    .prepare(
      `SELECT SUM(token_count) as total
       FROM conversation_history
       WHERE session_id = ? AND token_count IS NOT NULL`,
    )
    .get(sessionId) as { total: number | null } | undefined;
  return row?.total ?? 0;
}

export function getSessionMessageCount(jid: string, sessionId: string): number {
  const database = getDb(jid);
  const row = database
    .prepare(
      `SELECT COUNT(*) as count
       FROM conversation_history
       WHERE session_id = ?`,
    )
    .get(sessionId) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function getSessionLastTimestamp(
  jid: string,
  sessionId: string,
): string | null {
  const database = getDb(jid);
  const row = database
    .prepare(
      `SELECT created_at
       FROM conversation_history
       WHERE session_id = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(sessionId) as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

export function replaceSessionMessages(
  jid: string,
  sessionId: string,
  messages: ModelMessage[],
): void {
  const database = getDb(jid);
  const deleteStmt = database.prepare(
    `DELETE FROM conversation_history WHERE session_id = ?`,
  );
  const insertStmt = database.prepare(
    `INSERT INTO conversation_history (session_id, role, content, tool_calls, tool_results, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const now = new Date().toISOString();
  const insertMany = database.transaction(() => {
    deleteStmt.run(sessionId);
    for (const message of messages) {
      const { role, content, toolCalls, toolResults } =
        serializeMessage(message);
      insertStmt.run(
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
