import path from 'path';
import { z } from 'zod';

import { AGENTS_DIR } from '../../config.js';
import { createBaseTools } from '../../agent-runner/tool-registry.js';
import type { NanoClawDeps } from '../../agent-runner/tools/nanoclaw.js';
import type { WorkspaceContext } from '../../agent-runner/workspace-paths.js';
import type { RealtimeToolDefinition } from '../types.js';

type ToolLike = {
  description?: string;
  inputSchema?: unknown;
  execute?: (input: unknown) => Promise<unknown>;
};

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

export function createRealtimeToolBridge(input: {
  agentId: string;
  isMain: boolean;
  routeKey: string;
  linkedTextThreadId?: string;
  deps: NanoClawDeps;
}): RealtimeToolBridge {
  const workspace: WorkspaceContext = {
    agentDir: path.join(AGENTS_DIR, input.agentId),
    projectDir: process.cwd(),
    globalDir: path.join(AGENTS_DIR, 'global'),
    isMain: input.isMain,
  };

  const bridgedDeps: NanoClawDeps = {
    ...input.deps,
    sendMessage: async (jid, text, sender) => {
      const targetJid =
        jid.startsWith('voice:') && input.linkedTextThreadId
          ? input.linkedTextThreadId
          : jid;

      if (targetJid.startsWith('voice:') && !input.linkedTextThreadId) {
        throw new Error(
          'send_message requires a linked text thread during voice sessions',
        );
      }

      await input.deps.sendMessage(targetJid, text, sender);
    },
  };

  const tools = createBaseTools({
    workspace,
    nanoclawContext: {
      chatJid: input.linkedTextThreadId ?? input.routeKey,
      agentId: input.agentId,
      isMain: input.isMain,
    },
    nanoclawDeps: bridgedDeps,
  }) as unknown as Record<string, ToolLike>;

  const definitions = Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description ?? '',
    inputSchema: toJsonSchema(tool.inputSchema),
  }));

  return {
    definitions,
    execute: async (name, args) => {
      const tool = tools[name];
      if (!tool?.execute) {
        throw new Error(`Unknown realtime tool: ${name}`);
      }

      return await tool.execute(args);
    },
  };
}
