import { describe, expect, it, vi } from 'vitest';

const { saveMessage } = vi.hoisted(() => ({
  saveMessage: vi.fn(async () => undefined),
}));

vi.mock('../../agent-runner/session-store.js', () => ({
  saveMessage,
}));

import { createRealtimeToolBridge } from './nanoclaw-tools.js';

describe('realtime tool bridge', () => {
  it('exposes tool definitions and delegates execution', async () => {
    const runAgent = vi.fn(async () => ({
      status: 'success' as const,
      result: 'Background answer',
    }));
    const onDelegatedTaskUpdate = vi.fn(async () => undefined);
    const bridge = createRealtimeToolBridge({
      agentId: 'main',
      isMain: true,
      routeKey: 'voice:discord:dm:user-1',
      linkedTextThreadId: 'discord:guild-1:thread-1',
      linkedTextSessionId: 'session-1',
      deps: {
        sendMessage: async () => undefined,
        schedulerDeps: {
          agents: async () => ({
            main: {
              id: 'main',
              folder: 'main',
              name: 'Main',
              trigger: '@main',
              added_at: new Date().toISOString(),
              isMain: true,
            },
          }),
          getSessions: async () => ({}),
          runAgent,
          sendMessage: async () => undefined,
        },
      },
      onDelegatedTaskUpdate,
    });

    expect(bridge.definitions).toEqual([
      expect.objectContaining({ name: 'delegate_to_agent' }),
      expect.objectContaining({ name: 'leave_call' }),
    ]);

    await expect(bridge.execute('leave_call', {})).resolves.toMatchObject({
      ok: true,
      leaveCall: true,
      message: expect.stringContaining('Leaving the call'),
    });

    const result = await bridge.execute('delegate_to_agent', {
      agent_id: 'main',
      prompt: 'Research this for me',
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'running',
      agentId: 'main',
    });

    await vi.waitFor(() => {
      expect(runAgent).toHaveBeenCalled();
      expect(saveMessage).toHaveBeenCalledWith(
        'discord:guild-1:thread-1',
        'main',
        'session-1',
        {
          role: 'system',
          content: expect.stringContaining('Background answer'),
        },
        null,
      );
      expect(onDelegatedTaskUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'main',
          status: 'completed',
          message: expect.stringContaining('Background answer'),
        }),
      );
    });
  });
});
