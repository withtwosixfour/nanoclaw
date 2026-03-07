import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalCwd = process.cwd();

describe('realtime tool bridge', () => {
  afterEach(() => {
    process.chdir(originalCwd);
    vi.resetModules();
  });

  it('exposes tool definitions and routes send_message to linked text thread', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-tools-'));
    fs.mkdirSync(path.join(tempDir, 'agents', 'main'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'agents', 'global'), { recursive: true });
    process.chdir(tempDir);

    const sendMessage = vi.fn();
    const { createRealtimeToolBridge } = await import('./nanoclaw-tools.js');
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
    expect(sendMessage).toHaveBeenCalledWith(
      'discord:guild-1:thread-1',
      'hello from voice',
      undefined,
    );
  });
});
