import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { eq, and, or, sql } from 'drizzle-orm';
import type { ModelMessage } from 'ai';

import { getSessionPath, getAgentPath } from '../router.js';
import { logger } from '../logger.js';
import { db } from '../db/main/client.js';
import { conversationHistory } from '../db/main/schema.js';
import {
  deserializeStoredMessage,
  serializeMessageForStorage,
} from './message-store.js';

const COMPACTIONS_DIR = '.compactions';

function getSessionFilePath(jid: string): string {
  const sessionDir = getSessionPath(jid);
  return path.join(sessionDir, 'session.json');
}

export function getAgentCompactionsDir(agentId: string): string {
  const agentDir = getAgentPath(agentId);
  return path.join(agentDir, COMPACTIONS_DIR);
}

export async function saveCompactionOutput(
  agentId: string,
  sessionId: string,
  jid: string,
  summaryText: string,
  olderMessageCount: number,
  timestamp: string,
): Promise<string> {
  const compactionsDir = getAgentCompactionsDir(agentId);
  fs.mkdirSync(compactionsDir, { recursive: true });

  const sanitizedJid = jid.replace(/[:@]/g, '_');
  const filename = `${sanitizedJid}_${timestamp.replace(/[:.]/g, '-')}.md`;
  const filepath = path.join(compactionsDir, filename);

  const content = `# Session Compaction: ${sessionId}

**JID:** ${jid}  
**Timestamp:** ${timestamp}  
**Compacted Messages:** ${olderMessageCount}

## Summary

${summaryText}

---
*This file contains a summary of earlier conversation messages that were compacted to manage context window size.*
`;

  fs.writeFileSync(filepath, content, 'utf-8');
  logger.info(
    { agentId, sessionId, jid, filepath, olderMessageCount },
    'Saved compaction output to agent workspace',
  );

  return filepath;
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

  // Delete from main DB
  await db.delete(conversationHistory).where(eq(conversationHistory.jid, jid));
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
  const rows = await db
    .select({
      message: conversationHistory.message,
    })
    .from(conversationHistory)
    .where(
      and(
        eq(conversationHistory.sessionId, sessionId),
        eq(conversationHistory.jid, jid),
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

  return rows.map((row) => {
    if (!row.message) {
      throw new Error('Conversation history row missing canonical message');
    }
    return deserializeStoredMessage(row.message);
  });
}

export async function saveMessage(
  jid: string,
  agentId: string,
  sessionId: string,
  message: ModelMessage,
  tokenCount?: number | null,
): Promise<void> {
  const normalizedMessage = serializeMessageForStorage(message);

  await db.insert(conversationHistory).values({
    sessionId,
    jid,
    agentId,
    role: message.role,
    message: normalizedMessage,
    content: null,
    toolCalls: null,
    toolResults: null,
    tokenCount: tokenCount ?? null,
    createdAt: new Date().toISOString(),
  });
}

export async function getSessionTokenCount(
  jid: string,
  sessionId: string,
): Promise<number> {
  const result = await db
    .select({
      total: sql<number>`SUM(${conversationHistory.tokenCount})`,
    })
    .from(conversationHistory)
    .where(
      and(
        eq(conversationHistory.sessionId, sessionId),
        eq(conversationHistory.jid, jid),
        sql`${conversationHistory.tokenCount} IS NOT NULL`,
      ),
    );

  return result[0]?.total ?? 0;
}

export async function getSessionMessageCount(
  jid: string,
  sessionId: string,
): Promise<number> {
  const result = await db
    .select({
      count: sql<number>`COUNT(*)`,
    })
    .from(conversationHistory)
    .where(
      and(
        eq(conversationHistory.sessionId, sessionId),
        eq(conversationHistory.jid, jid),
      ),
    );

  return result[0]?.count ?? 0;
}

export async function getSessionLastTimestamp(
  jid: string,
  sessionId: string,
): Promise<string | null> {
  const result = await db
    .select({
      createdAt: conversationHistory.createdAt,
    })
    .from(conversationHistory)
    .where(
      and(
        eq(conversationHistory.sessionId, sessionId),
        eq(conversationHistory.jid, jid),
      ),
    )
    .orderBy(sql`${conversationHistory.id} DESC`)
    .limit(1);

  return result[0]?.createdAt ?? null;
}

export async function replaceSessionMessages(
  jid: string,
  agentId: string,
  sessionId: string,
  messages: ModelMessage[],
): Promise<void> {
  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    // Delete existing messages
    await tx
      .delete(conversationHistory)
      .where(
        and(
          eq(conversationHistory.sessionId, sessionId),
          eq(conversationHistory.jid, jid),
        ),
      );

    // Insert new messages
    for (const message of messages) {
      await tx.insert(conversationHistory).values({
        sessionId,
        jid,
        agentId,
        role: message.role,
        message: serializeMessageForStorage(message),
        content: null,
        toolCalls: null,
        toolResults: null,
        tokenCount: null,
        createdAt: now,
      });
    }
  });
}

export async function markMessageCompacted(
  jid: string,
  sessionId: string,
  upToId: number,
): Promise<void> {
  await db
    .update(conversationHistory)
    .set({
      isCompacted: true,
      compactedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(conversationHistory.sessionId, sessionId),
        eq(conversationHistory.jid, jid),
        eq(conversationHistory.id, upToId),
        sql`(${conversationHistory.isCompacted} IS NULL OR ${conversationHistory.isCompacted} = FALSE)`,
      ),
    );
}
