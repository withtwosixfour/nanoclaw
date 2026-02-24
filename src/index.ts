import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import {
  createChatSdkBot,
  agents,
  sessions,
  sendMessageToJid,
} from './chat-sdk-bot.js';
import { logger } from './logger.js';
import { formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { GroupQueue } from './group-queue.js';
import {
  AgentOutput,
  AgentInput,
  createAgentRuntime,
} from './agent-runner/runtime.js';
import { getOrCreateSessionId } from './agent-runner/session-store.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

// Create a minimal queue for scheduled tasks
const queue = new GroupQueue();

// Create agent runtime that sends messages via Chat SDK
const agentRuntime = createAgentRuntime({
  sendMessage: async (jid, text) => {
    try {
      await sendMessageToJid(jid, text);
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send message from agent runtime');
    }
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
      // Run the agent and stream results
      return new Promise((resolve) => {
        agentRuntime.run(input, async (output: AgentOutput) => {
          if (output.status === 'success' || output.status === 'error') {
            resolve({
              status: output.status,
              result: output.result,
              newSessionId: output.newSessionId || input.sessionId,
            });
          }
        });
      });
    },
    sendMessage: async (jid, rawText) => {
      const text = formatOutbound(rawText);
      if (!text) return;

      try {
        await sendMessageToJid(jid, text);
      } catch (err) {
        logger.error(
          { jid, err, text: text.slice(0, 50) },
          'Failed to send scheduled message',
        );
      }
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
