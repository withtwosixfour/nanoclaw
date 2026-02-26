import {
  getDb,
  loadMessages,
  markMessageCompacted,
} from '../agent-runner/session-store.js';
import { logger } from '../logger.js';
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
export function pruneToolOutputs(jid: string, sessionId: string): PruneResult {
  logger.debug({ jid, sessionId }, 'Starting tool output pruning');
  const startTime = Date.now();

  const db = getDb(jid);
  let total = 0;
  let pruned = 0;
  const toPrune: number[] = [];
  let turns = 0;

  // Get all messages including compacted ones
  const rows = db
    .prepare(
      `SELECT id, role, tool_results, is_compacted, compacted_at 
       FROM conversation_history
       WHERE session_id = ?
       ORDER BY id DESC`,
    )
    .all(sessionId) as Array<{
    id: number;
    role: string;
    tool_results: string | null;
    is_compacted: number;
    compacted_at: string | null;
  }>;

  // Get user message IDs for turn counting
  const userIds = loadMessages(jid, sessionId).filter((x) => x.role == 'user');

  // Walk backwards through messages
  loop: for (const row of rows) {
    // Count user turns (protect last 2)
    if (row.role === 'user') {
      turns++;
    }
    if (turns < 2) {
      continue; // Protect recent turns
    }

    // Stop if we hit an already compacted message
    if (row.is_compacted && row.compacted_at) {
      break loop;
    }

    // Process tool results
    if (row.role === 'tool' && row.tool_results) {
      try {
        // Check if this is a protected tool
        const toolResults = JSON.parse(row.tool_results) as Array<{
          toolName: string;
        }>;
        const isProtected = toolResults.some((result) =>
          PRUNE_PROTECTED_TOOLS.includes(result.toolName),
        );
        if (isProtected) {
          continue;
        }

        // Estimate tokens in this tool result
        const estimate = estimateTokens(row.tool_results);
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
    for (const messageId of toPrune) {
      markMessageCompacted(jid, sessionId, messageId);
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
export function shouldPrune(
  jid: string,
  sessionId: string,
  threshold: number = PRUNE_PROTECT,
): boolean {
  const db = getDb(jid);

  const rows = db
    .prepare(
      `SELECT tool_results FROM conversation_history
       WHERE session_id = ? AND role = 'tool' AND is_compacted = FALSE`,
    )
    .all(sessionId) as Array<{ tool_results: string }>;

  let totalTokens = 0;
  for (const row of rows) {
    totalTokens += estimateTokens(row.tool_results);
    if (totalTokens >= threshold) {
      return true;
    }
  }

  return false;
}
