import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { eq, and, or, isNull, sql } from 'drizzle-orm';
import type {
  JSONValue,
  ModelMessage,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from 'ai';

import { getSessionPath } from '../router.js';
import { logger } from '../logger.js';
import { getSessionDb, closeSessionDb } from '../db/sessions/client.js';
import { conversationHistory } from '../db/sessions/schema.js';
import { truncateOutput } from '../context/truncate.js';

function getSessionDbPath(jid: string): string {
  const sessionDir = getSessionPath(jid);
  return path.join(sessionDir, 'conversation.db');
}

function getSessionFilePath(jid: string): string {
  const sessionDir = getSessionPath(jid);
  return path.join(sessionDir, 'session.json');
}

export async function clearSession(jid: string): Promise<void> {
  const sessionFilePath = getSessionFilePath(jid);
  try {
    fs.unlinkSync(sessionFilePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  // Close the database connection before deleting the file
  const dbPath = getSessionDbPath(jid);
  closeSessionDb(dbPath);

  // Delete the database file
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

export async function loadMessages(
  jid: string,
  sessionId: string,
): Promise<ModelMessage[]> {
  const dbPath = getSessionDbPath(jid);
  const db = await getSessionDb(dbPath);

  const rows = await db
    .select({
      role: conversationHistory.role,
      content: conversationHistory.content,
      toolCalls: conversationHistory.toolCalls,
      toolResults: conversationHistory.toolResults,
    })
    .from(conversationHistory)
    .where(
      and(
        eq(conversationHistory.sessionId, sessionId),
        or(
          eq(conversationHistory.isCompacted, false),
          sql`${conversationHistory.isCompacted} IS NULL`,
        ),
        or(
          eq(conversationHistory.isCompactedSummary, false),
          sql`${conversationHistory.isCompactedSummary} IS NULL`,
        ),
      ),
    )
    .orderBy(conversationHistory.id);

  return rows.map((row) => deserializeMessage(row));
}

export async function saveMessage(
  jid: string,
  sessionId: string,
  message: ModelMessage,
  tokenCount?: number | null,
): Promise<void> {
  const dbPath = getSessionDbPath(jid);
  const db = await getSessionDb(dbPath);

  const { role, content, toolCalls, toolResults } = serializeMessage(message);

  await db.insert(conversationHistory).values({
    sessionId,
    role,
    content,
    toolCalls,
    toolResults,
    tokenCount: tokenCount ?? null,
    createdAt: new Date().toISOString(),
  });
}

export async function getSessionTokenCount(
  jid: string,
  sessionId: string,
): Promise<number> {
  const dbPath = getSessionDbPath(jid);
  const db = await getSessionDb(dbPath);

  const result = await db
    .select({
      total: sql<number>`SUM(${conversationHistory.tokenCount})`,
    })
    .from(conversationHistory)
    .where(
      and(
        eq(conversationHistory.sessionId, sessionId),
        sql`${conversationHistory.tokenCount} IS NOT NULL`,
      ),
    );

  return result[0]?.total ?? 0;
}

export async function getSessionMessageCount(
  jid: string,
  sessionId: string,
): Promise<number> {
  const dbPath = getSessionDbPath(jid);
  const db = await getSessionDb(dbPath);

  const result = await db
    .select({
      count: sql<number>`COUNT(*)`,
    })
    .from(conversationHistory)
    .where(eq(conversationHistory.sessionId, sessionId));

  return result[0]?.count ?? 0;
}

export async function getSessionLastTimestamp(
  jid: string,
  sessionId: string,
): Promise<string | null> {
  const dbPath = getSessionDbPath(jid);
  const db = await getSessionDb(dbPath);

  const result = await db
    .select({
      createdAt: conversationHistory.createdAt,
    })
    .from(conversationHistory)
    .where(eq(conversationHistory.sessionId, sessionId))
    .orderBy(sql`${conversationHistory.id} DESC`)
    .limit(1);

  return result[0]?.createdAt ?? null;
}

export async function replaceSessionMessages(
  jid: string,
  sessionId: string,
  messages: ModelMessage[],
): Promise<void> {
  const dbPath = getSessionDbPath(jid);
  const db = await getSessionDb(dbPath);

  const now = new Date().toISOString();

  // Delete existing messages and insert new ones in a transaction
  const sqlite = db.$client;
  const transaction = sqlite.transaction(() => {
    db.delete(conversationHistory)
      .where(eq(conversationHistory.sessionId, sessionId))
      .run();

    for (const message of messages) {
      const { role, content, toolCalls, toolResults } =
        serializeMessage(message);
      db.insert(conversationHistory)
        .values({
          sessionId,
          role,
          content,
          toolCalls,
          toolResults,
          tokenCount: null,
          createdAt: now,
        })
        .run();
    }
  });

  transaction();
}

export async function markMessageCompacted(
  jid: string,
  sessionId: string,
  upToId: number,
): Promise<void> {
  const dbPath = getSessionDbPath(jid);
  const db = await getSessionDb(dbPath);

  await db
    .update(conversationHistory)
    .set({
      isCompacted: true,
      compactedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(conversationHistory.sessionId, sessionId),
        eq(conversationHistory.id, upToId),
        sql`(${conversationHistory.isCompacted} IS NULL OR ${conversationHistory.isCompacted} = FALSE)`,
      ),
    );
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

  // For tool messages, truncate the output before saving to prevent DB bloat
  let toolResults: string | null = null;
  if (role === 'tool' && Array.isArray(message.content)) {
    const truncatedContent = message.content.map((part) => {
      if (isToolResultPart(part) && typeof part.output === 'string') {
        // Truncate the tool output and save full version to disk
        const truncateResult = truncateOutput(part.output, {
          maxLines: 500,
          maxBytes: 100 * 1024, // 100KB
          direction: 'head',
        });

        return {
          ...part,
          output: truncateResult.content,
        };
      }
      return part;
    });
    toolResults = JSON.stringify(truncatedContent);
  } else if (role === 'tool') {
    toolResults = JSON.stringify(message.content ?? []);
  }

  return {
    role,
    content,
    toolCalls,
    toolResults,
  };
}

function deserializeMessage(row: {
  role: string;
  content: string | null;
  toolCalls: string | null;
  toolResults: string | null;
}): ModelMessage {
  if (row.role === 'tool') {
    const toolResults = normalizeToolResults(row.toolResults);

    // Truncate tool results at load time to prevent context overflow
    // This handles both new and existing messages in the database
    const truncatedResults: ToolResultPart[] = toolResults.map((part) => {
      if (isToolResultPart(part) && typeof part.output === 'string') {
        // Truncate large outputs and save full version to disk
        const truncateResult = truncateOutput(part.output, {
          maxLines: 500,
          maxBytes: 100 * 1024, // 100KB
          direction: 'head',
        });

        return {
          ...part,
          output: truncateResult.content,
        } as unknown as ToolResultPart;
      }
      return part;
    });

    return {
      role: 'tool',
      content: truncatedResults,
    };
  }

  const message: ModelMessage = {
    role: row.role as 'user' | 'assistant' | 'system',
    content: row.content || '',
  };

  if (row.toolCalls) {
    (message as { toolCalls?: unknown }).toolCalls = JSON.parse(row.toolCalls);
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

function serializeToolCalls(
  parts: Array<ModelMessage['content'][number]>,
): string {
  const toolCalls = parts.filter(isToolCallPart).map((part) => ({
    toolName: part.toolName,
    toolCallId: part.toolCallId,
    input: part.input,
  }));
  return JSON.stringify(toolCalls);
}

function normalizeToolResults(toolResults: any): ToolResultPart[] {
  if (!toolResults) return [];
  try {
    return JSON.parse(toolResults) as ToolResultPart[];
  } catch (e) {
    logger.error(
      { err: JSON.stringify(e, Object.keys(e as any)) },
      'Error normalizing tool calls',
    );
    throw e;
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

function isTextPart(part: ModelMessage['content'][number]): part is TextPart {
  if (!part || typeof part !== 'object') return false;
  return part.type === 'text' && typeof part.text === 'string';
}

function isToolCallPart(
  part: ModelMessage['content'][number],
): part is ToolCallPart {
  if (!part || typeof part !== 'object') return false;
  return (
    part.type === 'tool-call' &&
    typeof part.toolName === 'string' &&
    typeof part.toolCallId === 'string'
  );
}

function isToolResultPart(
  part: ModelMessage['content'][number],
): part is ToolResultPart {
  if (!part || typeof part !== 'object') return false;
  return (
    part.type === 'tool-result' &&
    typeof part.toolName === 'string' &&
    typeof part.toolCallId === 'string'
  );
}
