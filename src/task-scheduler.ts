import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import {
  AGENTS_DIR,
  IDLE_TIMEOUT,
  MAIN_AGENT_ID,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { AgentOutput, AgentInput } from './agent-runner/runtime.js';
import {
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { Agent, ScheduledTask } from './types.js';
import { isNoReply } from './router.js';

export interface SchedulerDependencies {
  agents: () => Record<string, Agent>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  runAgent: (
    input: AgentInput,
    onOutput?: (output: AgentOutput) => Promise<void>,
  ) => Promise<AgentOutput>;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();

  logger.info(
    { taskId: task.id, agent: task.agent_id },
    'Running scheduled task',
  );

  const agents = deps.agents();
  const agent = agents[task.agent_id];

  if (!agent) {
    logger.error(
      { taskId: task.id, agentId: task.agent_id },
      'Agent not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Agent not found: ${task.agent_id}`,
    });
    return;
  }

  const isMain = task.agent_id === MAIN_AGENT_ID;

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the JID's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.chat_jid] : undefined;

  // Idle timer: closes the active run after IDLE_TIMEOUT of no output.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { taskId: task.id },
        'Scheduled task idle timeout, closing agent run',
      );
      deps.queue.closeStdin(task.chat_jid);
    }, IDLE_TIMEOUT);
  };

  try {
    const output = await deps.runAgent(
      {
        prompt: task.prompt,
        sessionId,
        agentId: task.agent_id,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        modelProvider: agent.modelProvider,
        modelName: agent.modelName,
      },
      async (streamedOutput: AgentOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user unless it's a NO_REPLY marker
          if (!isNoReply(streamedOutput.result)) {
            await deps.sendMessage(task.chat_jid, streamedOutput.result);
          }
          // Only reset idle timer on actual results, not session-update markers
          resetIdleTimer();
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (idleTimer) clearTimeout(idleTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Messages are sent via MCP tool (IPC), result text is just logged
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (idleTimer) clearTimeout(idleTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  let nextRun: string | null = null;
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    nextRun = interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    nextRun = new Date(Date.now() + ms).toISOString();
  }
  // 'once' tasks have no next run

  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}
