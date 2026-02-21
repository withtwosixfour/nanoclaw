import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { tool } from 'ai';

import { TIMEZONE } from '../../config.js';
import {
  createTask,
  deleteTask,
  getAllTasks,
  getTaskById,
  updateTask,
} from '../../db.js';
import { RegisteredGroup } from '../../types.js';

export interface NanoClawContext {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
}

export interface NanoClawDeps {
  sendMessage: (jid: string, text: string, sender?: string) => Promise<void>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
}

function formatTaskList(tasks: ReturnType<typeof getAllTasks>): string {
  return tasks
    .map(
      (t) =>
        `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
    )
    .join('\n');
}

function scheduleTask(
  deps: NanoClawDeps,
  ctx: NanoClawContext,
  args: {
    prompt: string;
    schedule_type: 'cron' | 'interval' | 'once';
    schedule_value: string;
    context_mode?: 'group' | 'isolated';
    target_group_jid?: string;
  },
): { ok: boolean; message: string } {
  if (args.schedule_type === 'cron') {
    try {
      CronExpressionParser.parse(args.schedule_value);
    } catch {
      return {
        ok: false,
        message: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
      };
    }
  } else if (args.schedule_type === 'interval') {
    const ms = parseInt(args.schedule_value, 10);
    if (isNaN(ms) || ms <= 0) {
      return {
        ok: false,
        message: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
      };
    }
  } else if (args.schedule_type === 'once') {
    const date = new Date(args.schedule_value);
    if (isNaN(date.getTime())) {
      return {
        ok: false,
        message: `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00" (no Z suffix).`,
      };
    }
  }

  const targetJid =
    ctx.isMain && args.target_group_jid ? args.target_group_jid : ctx.chatJid;

  const registeredGroups = deps.getRegisteredGroups();
  const targetGroupEntry = registeredGroups[targetJid];
  if (!targetGroupEntry) {
    return {
      ok: false,
      message: `Cannot schedule task: target group not registered (${targetJid}).`,
    };
  }

  if (!ctx.isMain && targetGroupEntry.folder !== ctx.groupFolder) {
    return {
      ok: false,
      message: 'Unauthorized schedule_task attempt blocked.',
    };
  }

  let nextRun: string | null = null;
  if (args.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(args.schedule_value, {
      tz: TIMEZONE,
    });
    nextRun = interval.next().toISOString();
  } else if (args.schedule_type === 'interval') {
    const ms = parseInt(args.schedule_value, 10);
    nextRun = new Date(Date.now() + ms).toISOString();
  } else if (args.schedule_type === 'once') {
    nextRun = new Date(args.schedule_value).toISOString();
  }

  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const contextMode =
    args.context_mode === 'group' || args.context_mode === 'isolated'
      ? args.context_mode
      : 'isolated';

  createTask({
    id: taskId,
    group_folder: targetGroupEntry.folder,
    chat_jid: targetJid,
    prompt: args.prompt,
    schedule_type: args.schedule_type,
    schedule_value: args.schedule_value,
    context_mode: contextMode,
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  });

  return {
    ok: true,
    message: `Task scheduled (${taskId}): ${args.schedule_type} - ${args.schedule_value}`,
  };
}

export function createNanoClawTools(deps: NanoClawDeps, ctx: NanoClawContext) {
  return {
    send_message: tool({
      description: 'Send a message to the user or group immediately.',
      inputSchema: z.object({
        text: z.string().describe('Message text'),
        sender: z.string().optional().describe('Optional sender identity'),
      }),
      execute: async (input: { text: string; sender?: string }) => {
        await deps.sendMessage(ctx.chatJid, input.text, input.sender);
        return { ok: true, message: 'Message sent.' };
      },
    }),
    schedule_task: tool({
      description: 'Schedule a recurring or one-time task.',
      inputSchema: z.object({
        prompt: z.string().describe('Task prompt'),
        schedule_type: z
          .enum(['cron', 'interval', 'once'])
          .describe('Schedule type'),
        schedule_value: z.string().describe('Schedule value'),
        context_mode: z.enum(['group', 'isolated']).optional(),
        target_group_jid: z.string().optional(),
      }),
      execute: async (input: {
        prompt: string;
        schedule_type: 'cron' | 'interval' | 'once';
        schedule_value: string;
        context_mode?: 'group' | 'isolated';
        target_group_jid?: string;
      }) => {
        const result = scheduleTask(deps, ctx, input);
        if (!result.ok) {
          return { error: result.message };
        }
        return { ok: true, message: result.message };
      },
    }),
    list_tasks: tool({
      description:
        "List scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
      inputSchema: z.object({}).optional(),
      execute: async () => {
        const allTasks = getAllTasks();
        const tasks = ctx.isMain
          ? allTasks
          : allTasks.filter((t) => t.group_folder === ctx.groupFolder);
        if (tasks.length === 0) {
          return { message: 'No scheduled tasks found.' };
        }
        return { message: `Scheduled tasks:\n${formatTaskList(tasks)}` };
      },
    }),
    pause_task: tool({
      description: 'Pause a scheduled task.',
      inputSchema: z.object({ task_id: z.string().describe('Task ID') }),
      execute: async (input: { task_id: string }) => {
        const task = getTaskById(input.task_id);
        if (!task) {
          return { error: 'Task not found.' };
        }
        if (!ctx.isMain && task.group_folder !== ctx.groupFolder) {
          return { error: 'Unauthorized task pause attempt.' };
        }
        updateTask(input.task_id, { status: 'paused' });
        return { ok: true, message: `Task ${input.task_id} pause requested.` };
      },
    }),
    resume_task: tool({
      description: 'Resume a scheduled task.',
      inputSchema: z.object({ task_id: z.string().describe('Task ID') }),
      execute: async (input: { task_id: string }) => {
        const task = getTaskById(input.task_id);
        if (!task) {
          return { error: 'Task not found.' };
        }
        if (!ctx.isMain && task.group_folder !== ctx.groupFolder) {
          return { error: 'Unauthorized task resume attempt.' };
        }
        updateTask(input.task_id, { status: 'active' });
        return { ok: true, message: `Task ${input.task_id} resume requested.` };
      },
    }),
    cancel_task: tool({
      description: 'Cancel and delete a scheduled task.',
      inputSchema: z.object({ task_id: z.string().describe('Task ID') }),
      execute: async (input: { task_id: string }) => {
        const task = getTaskById(input.task_id);
        if (!task) {
          return { error: 'Task not found.' };
        }
        if (!ctx.isMain && task.group_folder !== ctx.groupFolder) {
          return { error: 'Unauthorized task cancel attempt.' };
        }
        deleteTask(input.task_id);
        return {
          ok: true,
          message: `Task ${input.task_id} cancellation requested.`,
        };
      },
    }),
    register_group: tool({
      description: 'Register a new WhatsApp group (main group only).',
      inputSchema: z.object({
        jid: z.string().describe('WhatsApp JID'),
        name: z.string().describe('Display name'),
        folder: z.string().describe('Folder name'),
        trigger: z.string().describe('Trigger word'),
      }),
      execute: async (input: {
        jid: string;
        name: string;
        folder: string;
        trigger: string;
      }) => {
        if (!ctx.isMain) {
          return { error: 'Only the main group can register new groups.' };
        }
        deps.registerGroup(input.jid, {
          name: input.name,
          folder: input.folder,
          trigger: input.trigger,
          added_at: new Date().toISOString(),
        });
        return {
          ok: true,
          message: `Group "${input.name}" registered. It will start receiving messages immediately.`,
        };
      },
    }),
  };
}
