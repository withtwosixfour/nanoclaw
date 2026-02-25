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
import { logger } from './logger.js';
import { Agent, ScheduledTask } from './types.js';
import { isNoReply } from './router.js';

export interface SchedulerDependencies {
  agents: () => Record<string, Agent>;
  getSessions: () => Record<string, string>;
  runAgent: (input: AgentInput) => Promise<AgentOutput>;
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

  // For group context mode, use the thread's current session
  const sessions = deps.getSessions();
  // Use thread_id if available (new format), otherwise fall back to chat_jid (legacy)
  const threadId = task.thread_id || task.chat_jid;
  const sessionId =
    task.context_mode === 'group' ? sessions[threadId] : undefined;

  try {
    const output = await deps.runAgent({
      prompt: task.prompt,
      sessionId,
      agentId: task.agent_id,
      chatJid: threadId,
      isMain,
      isScheduledTask: true,
      modelProvider: agent.modelProvider,
      modelName: agent.modelName,
    });

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      result = output.result;
      // Forward result to user unless it's a NO_REPLY marker
      if (!isNoReply(output.result)) {
        await deps.sendMessage(threadId, output.result);
      }
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
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
    // schedule_value is stored as normalized milliseconds
    const ms = parseInt(task.schedule_value.trim(), 10);

    if (!isNaN(ms) && ms > 0) {
      nextRun = new Date(Date.now() + ms).toISOString();
    }
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
      logger.debug('Scheduler loop iteration starting');
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

        // Run task directly (no queue needed for simplified runtime)
        runTask(currentTask, deps).catch((err) => {
          logger.error(
            { taskId: currentTask.id, err },
            'Task execution failed',
          );
        });
      }
      logger.debug('Scheduler loop iteration completed');
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}
