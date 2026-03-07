import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';

const sendMessageToolExecute = vi.fn(async (args: { text: string }) => ({
  ok: true,
  text: args.text,
}));

vi.mock('../../agent-runner/tool-registry.js', () => ({
  createBaseTools: vi.fn(() => ({
    send_message: {
      description: 'Send message',
      inputSchema: z.object({ text: z.string() }),
      execute: sendMessageToolExecute,
    },
  })),
}));

import { createRealtimeToolBridge } from './nanoclaw-tools.js';

describe('realtime tool bridge', () => {
  it('exposes tool definitions and delegates execution', async () => {
    const sendMessage = vi.fn();
    const bridge = createRealtimeToolBridge({
      agentId: 'main',
      isMain: true,
      routeKey: 'voice:discord:dm:user-1',
      linkedTextThreadId: 'discord:guild-1:thread-1',
      deps: {
        sendMessage,
        schedulerDeps: {
          agents: async () => ({}),
          getSessions: async () => ({}),
          runAgent: async () => ({ status: 'success', result: 'ok' }),
          sendMessage: async () => undefined,
        },
      },
    });

    expect(
      bridge.definitions.some((tool) => tool.name === 'send_message'),
    ).toBe(true);

    await bridge.execute('send_message', { text: 'hello from voice' });
    expect(sendMessageToolExecute).toHaveBeenCalledWith({
      text: 'hello from voice',
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
