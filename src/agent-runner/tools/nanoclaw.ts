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
  setRoute,
} from '../../db.js';
import { Agent } from '../../types.js';
import { resolveAgentId, isNoReply } from '../../router.js';

export interface NanoClawContext {
  chatJid: string;
  agentId: string;
  isMain: boolean;
}

export interface NanoClawDeps {
  sendMessage: (jid: string, text: string, sender?: string) => Promise<void>;
  registerAgent: (id: string, agent: Agent) => void;
  getRegisteredAgents: () => Record<string, Agent>;
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
    target_jid?: string;
  },
): { ok: boolean; message: string; normalizedScheduleValue?: string } {
  let normalizedScheduleValue = args.schedule_value;

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
    // Parse duration strings like "30m", "1h", "2d" or plain milliseconds
    const durationValue = args.schedule_value.trim();
    const durationMatch = durationValue.match(/^(\d+)\s*([smhd])?$/i);
    let ms: number;

    if (durationMatch) {
      const num = parseInt(durationMatch[1], 10);
      const unit = (durationMatch[2] || 's').toLowerCase();
      switch (unit) {
        case 's':
          ms = num * 1000;
          break;
        case 'm':
          ms = num * 60 * 1000;
          break;
        case 'h':
          ms = num * 60 * 60 * 1000;
          break;
        case 'd':
          ms = num * 24 * 60 * 60 * 1000;
          break;
        default:
          ms = num;
      }
    } else {
      ms = parseInt(durationValue, 10);
    }

    if (isNaN(ms) || ms <= 0) {
      return {
        ok: false,
        message: `Invalid interval: "${args.schedule_value}". Use format like "30m" (30 minutes), "1h" (1 hour), "2d" (2 days), or milliseconds like "300000" (5 min).`,
      };
    }

    // Store normalized milliseconds
    normalizedScheduleValue = String(ms);
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
    ctx.isMain && args.target_jid ? args.target_jid : ctx.chatJid;

  // Check that target JID has a route
  const targetAgentId = resolveAgentId(targetJid);
  if (!targetAgentId) {
    return {
      ok: false,
      message: `Cannot schedule task: target JID not routed (${targetJid}). Add a route via add_route first.`,
    };
  }

  if (!ctx.isMain && targetAgentId !== ctx.agentId) {
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
    // Use the normalized milliseconds value directly
    const ms = parseInt(normalizedScheduleValue, 10);
    nextRun = new Date(Date.now() + ms).toISOString();
  } else if (args.schedule_type === 'once') {
    // Use schedule_value directly as the target time (no timezone conversion)
    // User provides time in their desired timezone, we store as-is
    nextRun = args.schedule_value;
  }

  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const contextMode =
    args.context_mode === 'group' || args.context_mode === 'isolated'
      ? args.context_mode
      : 'isolated';

  createTask({
    id: taskId,
    agent_id: targetAgentId,
    chat_jid: targetJid,
    prompt: args.prompt,
    schedule_type: args.schedule_type,
    schedule_value: normalizedScheduleValue,
    context_mode: contextMode,
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  });

  return {
    ok: true,
    message: `Task scheduled (${taskId}): ${args.schedule_type} - ${args.schedule_value}`,
    normalizedScheduleValue,
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
        if (isNoReply(input.text)) {
          return { ok: true, message: 'Message suppressed (NO_REPLY).' };
        }
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
        target_jid: z.string().optional().describe('Target JID (main only)'),
      }),
      execute: async (input: {
        prompt: string;
        schedule_type: 'cron' | 'interval' | 'once';
        schedule_value: string;
        context_mode?: 'group' | 'isolated';
        target_jid?: string;
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
        "List scheduled tasks. From main: shows all tasks. From other agents: shows only that agent's tasks.",
      inputSchema: z.object({}).optional(),
      execute: async () => {
        const allTasks = getAllTasks();
        const tasks = ctx.isMain
          ? allTasks
          : allTasks.filter((t) => t.agent_id === ctx.agentId);
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
        if (!ctx.isMain && task.agent_id !== ctx.agentId) {
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
        if (!ctx.isMain && task.agent_id !== ctx.agentId) {
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
        if (!ctx.isMain && task.agent_id !== ctx.agentId) {
          return { error: 'Unauthorized task cancel attempt.' };
        }
        deleteTask(input.task_id);
        return {
          ok: true,
          message: `Task ${input.task_id} cancellation requested.`,
        };
      },
    }),
    register_agent: tool({
      description: 'Register a new agent (main agent only).',
      inputSchema: z.object({
        id: z.string().describe('Agent ID (e.g., "coding-agent")'),
        name: z.string().describe('Display name'),
        folder: z.string().describe('Folder name'),
        trigger: z.string().describe('Trigger word'),
      }),
      execute: async (input: {
        id: string;
        name: string;
        folder: string;
        trigger: string;
      }) => {
        if (!ctx.isMain) {
          return { error: 'Only the main agent can register new agents.' };
        }

        // Create agent with required id field
        const agent: Agent = {
          id: input.id,
          name: input.name,
          folder: input.folder,
          trigger: input.trigger,
          added_at: new Date().toISOString(),
        };

        deps.registerAgent(input.id, agent);
        return {
          ok: true,
          message: `Agent "${input.name}" registered. Add a route via add_route to connect JIDs to this agent.`,
        };
      },
    }),
    add_route: tool({
      description:
        'Add a route from a JID pattern to an agent (main agent only). Routes are persisted to the database and survive restarts. Use * for wildcards (e.g., "whatsapp:*", "dc:*", "*").',
      inputSchema: z.object({
        jid: z
          .string()
          .describe(
            'JID pattern to route (e.g., "dc:123456789", "whatsapp:*", "*")',
          ),
        agent_id: z.string().describe('Agent ID to route to'),
      }),
      execute: async (input: { jid: string; agent_id: string }) => {
        if (!ctx.isMain) {
          return { error: 'Only the main agent can add routes.' };
        }

        // Verify agent exists
        const agents = deps.getRegisteredAgents();
        if (!agents[input.agent_id]) {
          return { error: `Agent "${input.agent_id}" not found.` };
        }

        // Add route in-memory and persist to database
        setRoute(input.jid, input.agent_id);
        return {
          ok: true,
          message: `Route added and persisted: ${input.jid} -> ${input.agent_id}.`,
        };
      },
    }),
    list_agents: tool({
      description: 'List all registered agents.',
      inputSchema: z.object({}).optional(),
      execute: async () => {
        const agents = deps.getRegisteredAgents();
        const agentList = Object.values(agents)
          .map((a) => `- ${a.id}: ${a.name} (trigger: ${a.trigger})`)
          .join('\n');
        return {
          message: agentList || 'No agents registered.',
        };
      },
    }),
  };
}
