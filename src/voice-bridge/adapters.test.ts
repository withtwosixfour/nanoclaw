import EventEmitter from 'events';

import { describe, expect, it, vi } from 'vitest';

import { DiscordVoiceAdapter } from './adapters/discord.js';
import { SlackHuddlesAdapter } from './adapters/slack-huddles.js';

class FakeTransport extends EventEmitter {
  connect = vi.fn(async () => undefined);
  startDirectSession = vi.fn(async () => ({ sessionId: 'session-1' }));
  joinExistingSession = vi.fn(async () => ({ sessionId: 'session-2' }));
  stopSession = vi.fn(async () => undefined);
  sendAudio = vi.fn(async () => undefined);
  interruptOutput = vi.fn(async () => undefined);
  onEvent(handler: (event: any) => void): void {
    this.on('event', handler);
  }
}

describe('voice adapters', () => {
  it('wraps discord transport', async () => {
    const transport = new FakeTransport();
    const adapter = new DiscordVoiceAdapter(transport as any);
    const handler = vi.fn();
    adapter.onEvent(handler);

    await adapter.connect();
    await adapter.startDirectSession('user-1');
    transport.emit('event', {
      type: 'session.started',
      sessionId: 'session-1',
      platform: 'discord',
    });

    expect(transport.connect).toHaveBeenCalled();
    expect(handler).toHaveBeenCalled();
  });

  it('wraps slack transport', async () => {
    const transport = new FakeTransport();
    const adapter = new SlackHuddlesAdapter(transport as any);

    await adapter.joinExistingSession('huddle-1');
    expect(transport.joinExistingSession).toHaveBeenCalledWith('huddle-1');
  });
});
