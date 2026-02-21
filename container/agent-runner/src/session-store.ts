import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { CoreMessage } from 'ai';

const STORE_DIR = path.join('/workspace/group', '.nanoclaw');
const DB_PATH = path.join(STORE_DIR, 'conversation.db');
const SESSION_PATH = path.join(STORE_DIR, 'session.json');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(STORE_DIR, { recursive: true });
  db = new Database(DB_PATH);
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
  return db;
}

export function getOrCreateSessionId(groupFolder: string): string {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  if (fs.existsSync(SESSION_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8')) as {
        sessionId?: string;
      };
      if (data.sessionId) return data.sessionId;
    } catch {
      // ignore corrupted session file
    }
  }

  const sessionId = randomUUID();
  fs.writeFileSync(
    SESSION_PATH,
    JSON.stringify({ sessionId, groupFolder }, null, 2),
  );
  return sessionId;
}

export function loadMessages(
  groupFolder: string,
  sessionId: string,
): CoreMessage[] {
  const database = getDb();
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
  message: CoreMessage,
  tokenCount?: number | null,
): void {
  const database = getDb();
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

export function getSessionTokenCount(sessionId: string): number {
  const database = getDb();
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
  messages: CoreMessage[],
): void {
  const database = getDb();
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

function serializeMessage(message: CoreMessage): {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  toolCalls: string | null;
  toolResults: string | null;
} {
  const role = message.role as 'user' | 'assistant' | 'system' | 'tool';
  const content = extractContentText(message);
  const toolCalls = (message as { toolCalls?: unknown }).toolCalls
    ? JSON.stringify((message as { toolCalls?: unknown }).toolCalls)
    : null;
  const toolResults = (message as { toolName?: string; toolCallId?: string })
    .toolName
    ? JSON.stringify({
        toolName: (message as { toolName?: string }).toolName,
        toolCallId: (message as { toolCallId?: string }).toolCallId,
        result: content,
      })
    : null;

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
}): CoreMessage {
  if (row.role === 'tool') {
    const toolData = row.tool_results
      ? (JSON.parse(row.tool_results) as {
          toolName?: string;
          toolCallId?: string;
          result?: string;
        })
      : {};
    return {
      role: 'tool',
      content: row.content || toolData.result || '',
      toolName: toolData.toolName,
      toolCallId: toolData.toolCallId,
    } as CoreMessage;
  }

  const message: CoreMessage = {
    role: row.role,
    content: row.content || '',
  } as CoreMessage;

  if (row.tool_calls) {
    (message as { toolCalls?: unknown }).toolCalls = JSON.parse(row.tool_calls);
  }

  return message;
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
