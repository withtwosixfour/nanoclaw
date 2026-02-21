import path from 'path';
import { z } from 'zod';
import { tool } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

interface McpClientOptions {
  mcpServerPath: string;
  env: Record<string, string | undefined>;
}

let clientPromise: Promise<Client> | null = null;

async function getClient(options: McpClientOptions): Promise<Client> {
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const transport = new StdioClientTransport({
      command: 'node',
      args: [options.mcpServerPath],
      env: { ...process.env, ...options.env },
      cwd: path.dirname(options.mcpServerPath),
    });
    const client = new Client({
      name: 'nanoclaw-agent-runner',
      version: '1.0.0',
    });
    await client.connect(transport);
    return client;
  })();

  return clientPromise;
}

async function callMcpTool(
  options: McpClientOptions,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const client = await getClient(options);
  const result = await (
    client as unknown as {
      callTool: (input: {
        name: string;
        arguments: Record<string, unknown>;
      }) => Promise<unknown>;
    }
  ).callTool({ name, arguments: args });
  return result;
}

export function createMcpTools(options: McpClientOptions) {
  return {
    send_message: tool({
      description: 'Send a message to the user or group immediately.',
      parameters: z.object({
        text: z.string().describe('Message text'),
        sender: z.string().optional().describe('Optional sender identity'),
      }),
      execute: async (input: { text: string; sender?: string }) =>
        callMcpTool(options, 'send_message', input),
    }),
    schedule_task: tool({
      description: 'Schedule a recurring or one-time task.',
      parameters: z.object({
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
      }) => callMcpTool(options, 'schedule_task', input),
    }),
    list_tasks: tool({
      description: 'List scheduled tasks.',
      parameters: z.object({}).optional(),
      execute: async () => callMcpTool(options, 'list_tasks', {}),
    }),
    pause_task: tool({
      description: 'Pause a scheduled task.',
      parameters: z.object({ task_id: z.string().describe('Task ID') }),
      execute: async (input: { task_id: string }) =>
        callMcpTool(options, 'pause_task', input),
    }),
    resume_task: tool({
      description: 'Resume a scheduled task.',
      parameters: z.object({ task_id: z.string().describe('Task ID') }),
      execute: async (input: { task_id: string }) =>
        callMcpTool(options, 'resume_task', input),
    }),
    cancel_task: tool({
      description: 'Cancel a scheduled task.',
      parameters: z.object({ task_id: z.string().describe('Task ID') }),
      execute: async (input: { task_id: string }) =>
        callMcpTool(options, 'cancel_task', input),
    }),
    register_group: tool({
      description: 'Register a new WhatsApp group (main group only).',
      parameters: z.object({
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
      }) => callMcpTool(options, 'register_group', input),
    }),
  };
}
