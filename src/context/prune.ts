import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/main/client.js';
import { conversationHistory } from '../db/main/schema.js';
import { logger } from '../logger.js';
import {
  deserializeStoredMessage,
  getToolNames,
  getToolPayloadForPruning,
} from '../agent-runner/message-store.js';
import { estimateTokens } from './token.js';

// Thresholds (from opencode)
const PRUNE_MINIMUM = 20_000; // Must exceed this to actually prune
const PRUNE_PROTECT = 40_000; // Protection threshold
const PRUNE_PROTECTED_TOOLS = ['skill']; // Never prune these tools

export interface PruneResult {
  pruned: number; // Tokens pruned
  total: number; // Total tokens scanned
  count: number; // Number of messages marked
  protectedTurns: number; // Number of user turns protected
}

/**
 * Prune old tool outputs from the conversation.
 * Walks backwards through history, protecting recent turns.
 * When a tool result is pruned, its corresponding tool call is also excluded at load time.
 */
export async function pruneToolOutputs(
  jid: string,
  sessionId: string,
): Promise<PruneResult> {
  logger.debug({ jid, sessionId }, 'Starting tool output pruning');
  const startTime = Date.now();

  let total = 0;
  let pruned = 0;
  const toPrune: number[] = [];
  let turns = 0;

  // Get all messages including compacted ones
  const rows = await db
    .select({
      id: conversationHistory.id,
      message: conversationHistory.message,
      isCompacted: conversationHistory.isCompacted,
      compactedAt: conversationHistory.compactedAt,
    })
    .from(conversationHistory)
    .where(
      and(
        eq(conversationHistory.sessionId, sessionId),
        eq(conversationHistory.jid, jid),
      ),
    )
    .orderBy(sql`${conversationHistory.id} DESC`);

  // Walk backwards through messages
  loop: for (const row of rows) {
    // Count user turns (protect last 2)
    if (!row.message) {
      continue;
    }

    const message = deserializeStoredMessage(row.message);

    if (message.role === 'user') {
      turns++;
    }
    if (turns < 2) {
      continue; // Protect recent turns
    }

    // Stop if we hit an already compacted message
    if (row.isCompacted && row.compactedAt) {
      break loop;
    }

    // Process tool results
    if (message.role === 'tool') {
      try {
        const toolPayload = getToolPayloadForPruning(message);
        if (!toolPayload) {
          continue;
        }

        const isProtected = getToolNames(message).some((toolName) =>
          PRUNE_PROTECTED_TOOLS.includes(toolName),
        );
        if (isProtected) {
          continue;
        }

        // Estimate tokens in this tool result
        const estimate = estimateTokens(toolPayload);
        total += estimate;

        // If we've exceeded the protection threshold, mark for pruning
        if (total > PRUNE_PROTECT) {
          pruned += estimate;
          toPrune.push(row.id);
        }
      } catch {
        // Skip if parsing fails
      }
    }
  }

  // Only prune if we exceeded the minimum threshold
  if (pruned > PRUNE_MINIMUM && toPrune.length > 0) {
    const now = new Date().toISOString();
    for (const messageId of toPrune) {
      await db
        .update(conversationHistory)
        .set({
          isCompacted: true,
          compactedAt: now,
        })
        .where(
          and(
            eq(conversationHistory.sessionId, sessionId),
            eq(conversationHistory.jid, jid),
            eq(conversationHistory.id, messageId),
          ),
        );
    }
    logger.info(
      {
        jid,
        sessionId,
        count: toPrune.length,
        pruned,
        durationMs: Date.now() - startTime,
      },
      'Pruned tool outputs',
    );
  }

  return {
    pruned,
    total,
    count: toPrune.length,
    protectedTurns: Math.min(turns, 2),
  };
}

/**
 * Check if pruning is needed based on estimated token count.
 */
export async function shouldPrune(
  jid: string,
  sessionId: string,
  threshold: number = PRUNE_PROTECT,
): Promise<boolean> {
  const rows = await db
    .select({
      message: conversationHistory.message,
    })
    .from(conversationHistory)
    .where(
      and(
        eq(conversationHistory.sessionId, sessionId),
        eq(conversationHistory.jid, jid),
        eq(conversationHistory.role, 'tool'),
        sql`(${conversationHistory.isCompacted} IS NULL OR ${conversationHistory.isCompacted} = FALSE)`,
      ),
    );

  let totalTokens = 0;
  for (const row of rows) {
    if (!row.message) {
      continue;
    }

    const message = deserializeStoredMessage(row.message);
    const toolPayload = getToolPayloadForPruning(message);
    if (!toolPayload) {
      continue;
    }

    totalTokens += estimateTokens(toolPayload);
    if (totalTokens >= threshold) {
      return true;
    }
  }

  return false;
}
