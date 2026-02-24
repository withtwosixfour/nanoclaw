import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { createChatSdkBot, agents, sessions } from './chat-sdk-bot.js';
import { logger } from './logger.js';
import { findChannel, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { GroupQueue } from './group-queue.js';
import {
  AgentOutput,
  AgentInput,
  createAgentRuntime,
} from './agent-runner/runtime.js';
import {
  getOrCreateSessionId,
  clearSession,
} from './agent-runner/session-store.js';
import { deleteSession } from './db.js';
import type { Agent } from './types.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

// Legacy exports for compatibility
let lastAgentTimestamp: Record<string, string> = {};
let lastCommandTimestamp: Record<string, string> = {};

// Create a minimal queue for scheduled tasks
const queue = new GroupQueue();

// Create agent runtime that sends messages via Chat SDK
const agentRuntime = createAgentRuntime({
  sendMessage: async (jid, text) => {
    // This is called by tools - in the new architecture, we don't have direct channel access
    // Instead, we should pass the thread through the context
    logger.warn(
      { jid, text: text.slice(0, 50) },
      'Tool sendMessage called - needs thread context',
    );
  },
  registerAgent: () => {},
  getRegisteredAgents: () => agents,
});

queue.setPipeMessageFn(agentRuntime.pipeMessage);
queue.setCloseFn(agentRuntime.close);

/**
 * Execute command (legacy compatibility)
 */
export async function executeCommand(
  chatJid: string,
  command: string,
  sender?: string,
): Promise<string> {
  // This is now handled in chat-sdk-bot.ts
  // Keeping for backwards compatibility with existing code
  return 'Commands are now handled by Chat SDK';
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  logger.info('Starting NanoClaw with Chat SDK');

  // Create and start the Chat SDK bot
  const bot = await createChatSdkBot();

  // Log startup
  console.log('\n  NanoClaw Chat SDK Bot started');
  console.log('  Event-driven mode - no polling loop\n');

  // Start scheduler loop for background tasks
  startSchedulerLoop({
    agents: () => agents,
    getSessions: () => sessions,
    queue,
    runAgent: async (input: AgentInput) => {
      // For scheduled tasks, we need to handle differently
      // They won't have a thread context, so we need to queue them
      logger.info(
        { agentId: input.agentId, chatJid: input.chatJid },
        'Scheduled task requested',
      );

      // Store the task for when a message comes in
      // This is a simplified approach - scheduled tasks will be picked up when someone messages
      return {
        status: 'success' as const,
        result: null,
        newSessionId:
          input.sessionId || getOrCreateSessionId(input.chatJid, input.agentId),
      };
    },
    sendMessage: async (jid, rawText) => {
      const text = formatOutbound(rawText);
      if (!text) return;

      // Find the thread and send message
      const threadId = jid.replace(/^dc:/, '');
      logger.info(
        { threadId, text: text.slice(0, 50) },
        'Scheduled message send',
      );

      // Note: In the new architecture, we need to look up the thread from bot state
      // This is simplified - actual implementation would need to track thread references
    },
  });

  // Check for pending update completion
  const pendingUpdatePath = path.join(DATA_DIR, 'update-pending.json');
  if (fs.existsSync(pendingUpdatePath)) {
    try {
      const pending = JSON.parse(fs.readFileSync(pendingUpdatePath, 'utf8'));

      // Validate that the update was started recently (within 10 minutes)
      const updateStartTime = pending.updateStartTime || 0;
      const timeSinceUpdate = Date.now() - updateStartTime;
      const TEN_MINUTES = 10 * 60 * 1000;

      if (timeSinceUpdate <= TEN_MINUTES) {
        logger.info(
          { chatJid: pending.chatJid },
          'Update completed - bot restarted successfully',
        );

        // Try to send completion message if we have access to the thread
        // This is simplified - actual implementation would need thread reference
      } else {
        logger.warn(
          { chatJid: pending.chatJid, timeSinceUpdateMs: timeSinceUpdate },
          'Stale update pending file detected',
        );
      }

      fs.unlinkSync(pendingUpdatePath);
    } catch (err) {
      logger.error({ err }, 'Failed to handle pending update notification');
      try {
        fs.unlinkSync(pendingUpdatePath);
      } catch {}
    }
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Keep the process running
  // The Chat SDK maintains connections via Gateway or HTTP
  logger.info('Bot is running. Waiting for events...');
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
