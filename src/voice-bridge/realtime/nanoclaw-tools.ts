import { randomUUID } from 'crypto';
import { z } from 'zod';

import { saveMessage } from '../../agent-runner/session-store.js';
import { logger } from '../../logger.js';
import type { NanoClawDeps } from '../../agent-runner/tools/nanoclaw.js';
import type { RealtimeToolDefinition } from '../types.js';

function toJsonSchema(inputSchema: unknown): Record<string, unknown> {
  if (!inputSchema) {
    return { type: 'object', properties: {}, additionalProperties: false };
  }

  if (inputSchema instanceof z.ZodType) {
    return z.toJSONSchema(inputSchema);
  }

  return { type: 'object', additionalProperties: true };
}

export interface RealtimeToolBridge {
  definitions: RealtimeToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export interface DelegatedTaskUpdate {
  taskId: string;
  agentId: string;
  status: 'completed' | 'failed';
  message: string;
  announce: boolean;
}

export interface LeaveCallToolResult {
  ok: true;
  leaveCall: true;
  message: string;
}

export function isLeaveCallToolResult(
  value: unknown,
): value is LeaveCallToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'leaveCall' in value &&
    (value as { leaveCall?: unknown }).leaveCall === true
  );
}

function truncateForRealtime(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`;
}

function formatDelegatedPrompt(taskId: string, prompt: string): string {
  return [
    `[DELEGATED BACKGROUND TASK ${taskId}]`,
    'You are helping a realtime agent by completing a task asynchronously.',
    'Do the work thoroughly, but return only the useful result for the requesting agent.',
    'Do not send messages directly to the user unless the task explicitly requires cross-channel delivery.',
    'The requesting realtime agent will decide how to present your result.',
    '',
    prompt,
  ].join('\n');
}

async function persistDelegatedUpdate(input: {
  linkedTextThreadId?: string;
  linkedTextSessionId?: string;
  agentId: string;
  message: string;
}): Promise<void> {
  if (!input.linkedTextThreadId || !input.linkedTextSessionId) {
    return;
  }

  await saveMessage(
    input.linkedTextThreadId,
    input.agentId,
    input.linkedTextSessionId,
    { role: 'system', content: input.message },
    null,
  );
}

async function emitDelegatedTaskUpdate(
  callback: ((update: DelegatedTaskUpdate) => Promise<void>) | undefined,
  update: DelegatedTaskUpdate,
): Promise<void> {
  if (!callback) {
    return;
  }

  try {
    await callback(update);
  } catch (err) {
    logger.error(
      {
        err,
        taskId: update.taskId,
        agentId: update.agentId,
        status: update.status,
      },
      'Failed to deliver delegated task update to realtime session',
    );
  }
}

export function createRealtimeToolBridge(input: {
  agentId: string;
  isMain: boolean;
  routeKey: string;
  linkedTextThreadId?: string;
  linkedTextSessionId?: string;
  deps: NanoClawDeps;
  onDelegatedTaskUpdate?: (update: DelegatedTaskUpdate) => Promise<void>;
}): RealtimeToolBridge {
  const delegateInputSchema = z.object({
    agent_id: z.string().describe('Agent ID to delegate work to'),
    prompt: z.string().describe('Task for the delegated agent'),
    announce_result: z
      .boolean()
      .optional()
      .describe(
        'Whether to prompt the realtime model when the result comes back. Defaults to true.',
      ),
  });

  const definitions = [
    {
      name: 'delegate_to_agent',
      description:
        'Delegate a background task to another agent and return immediately so the realtime conversation can continue.',
      inputSchema: toJsonSchema(delegateInputSchema),
    },
    {
      name: 'leave_call',
      description:
        'Leave the current live call when the conversation is complete or the user asks you to go.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  ];

  return {
    definitions,
    execute: async (name, args) => {
      if (name === 'leave_call') {
        void args;
        return {
          ok: true,
          leaveCall: true,
          message: 'Leaving the call now.',
        } satisfies LeaveCallToolResult;
      }

      if (name !== 'delegate_to_agent') {
        throw new Error(`Unknown realtime tool: ${name}`);
      }

      const parsed = delegateInputSchema.parse(args);

      const agents = await input.deps.schedulerDeps.agents();
      const agent = agents[parsed.agent_id];
      if (!agent) {
        return { error: `Agent "${parsed.agent_id}" not found.` };
      }

      const taskId = `delegated-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const announce = parsed.announce_result ?? true;
      const backgroundChatJid = `voice-delegated:${input.routeKey}:${taskId}`;

      void (async () => {
        let update: DelegatedTaskUpdate;

        try {
          const result = await input.deps.schedulerDeps.runAgent({
            prompt: formatDelegatedPrompt(taskId, parsed.prompt),
            agentId: agent.id,
            chatJid: backgroundChatJid,
            isMain: agent.isMain ?? false,
            modelProvider: agent.modelProvider,
            modelName: agent.modelName,
          });

          const message =
            result.status === 'success'
              ? result.result
                ? `Delegated task ${taskId} completed by agent ${agent.id}.\n\n${truncateForRealtime(result.result)}`
                : `Delegated task ${taskId} completed by agent ${agent.id}, but it did not return any text.`
              : `Delegated task ${taskId} failed in agent ${agent.id}.\n\n${truncateForRealtime(result.error ?? 'Unknown error')}`;

          await persistDelegatedUpdate({
            linkedTextThreadId: input.linkedTextThreadId,
            linkedTextSessionId: input.linkedTextSessionId,
            agentId: input.agentId,
            message,
          });

          update = {
            taskId,
            agentId: agent.id,
            status: result.status === 'success' ? 'completed' : 'failed',
            message,
            announce,
          };
        } catch (err) {
          const message = `Delegated task ${taskId} failed in agent ${agent.id}.\n\n${truncateForRealtime(
            err instanceof Error ? err.message : String(err),
          )}`;

          await persistDelegatedUpdate({
            linkedTextThreadId: input.linkedTextThreadId,
            linkedTextSessionId: input.linkedTextSessionId,
            agentId: input.agentId,
            message,
          });

          update = {
            taskId,
            agentId: agent.id,
            status: 'failed',
            message,
            announce,
          };
        }

        await emitDelegatedTaskUpdate(input.onDelegatedTaskUpdate, update);
      })();

      return {
        ok: true,
        taskId,
        status: 'running',
        agentId: agent.id,
        message: `Delegated task ${taskId} to agent ${agent.id}. It is running in the background now.`,
      };
    },
  };
}
