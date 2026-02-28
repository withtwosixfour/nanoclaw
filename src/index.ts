import { config } from 'dotenv';
config({ path: path.join(process.cwd(), '.env') });

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config';
import { createChatSdkBot, sendMessageToJid } from './chat-sdk-bot';
import { logger } from './logger';
import { formatOutbound } from './router';
import { startSchedulerLoop } from './task-scheduler';
import { GroupQueue } from './group-queue';
import { runMigrations } from '../scripts/migrate';
import { getAllAgents, getAllSessions } from './db';
import { AgentInput, createAgentRuntime } from './agent-runner/runtime';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router';

await runMigrations();

// Catch unhandled errors to prevent lock issues
process.on('unhandledRejection', (reason, promise) => {
  logger.error(
    {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    },
    'Unhandled Promise Rejection - this may cause lock issues',
  );
  // Don't exit - let the process continue
});

process.on('uncaughtException', (err) => {
  logger.error(
    { error: err.message, stack: err.stack },
    'Uncaught Exception - process may be unstable',
  );
  // In production, you might want to exit here, but for now we continue
});

// Create a minimal queue for scheduled tasks
const queue = new GroupQueue();

// Create agent runtime that sends messages via Chat SDK
logger.info('Initializing agent runtime with Chat SDK message handler');
const agentRuntime = createAgentRuntime({
  sendMessage: async (jid, text) => {
    try {
      await sendMessageToJid(jid, text);
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send message from agent runtime');
    }
  },
  getRegisteredAgents: async () => await getAllAgents(),
});

/**
 * Main entry point
 */
async function main(): Promise<void> {
  logger.info('Starting NanoClaw with Chat SDK');

  // Log startup
  console.log('\n  NanoClaw Chat SDK Bot started');
  console.log('  Event-driven mode - no polling loop\n');

  logger.info('Database initialized');

  // Start scheduler loop for background tasks
  startSchedulerLoop({
    agents: async () => await getAllAgents(),
    getSessions: async () => {
      const sessions: Record<string, string> = {};
      const dbSessions = await getAllSessions();
      for (const [jid, data] of Object.entries(dbSessions)) {
        sessions[jid] = data.sessionId;
      }
      return sessions;
    },
    runAgent: async (input: AgentInput) => {
      // Run the agent and return result
      return await agentRuntime.run(input);
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
  logger.info('Initializing bot');

  await createChatSdkBot();

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
