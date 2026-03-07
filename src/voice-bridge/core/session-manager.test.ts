import EventEmitter from 'events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbFns = {
  appendVoiceTranscript: vi.fn(),
  markVoiceParticipantLeft: vi.fn(),
  markVoiceSessionEnded: vi.fn(),
  upsertVoiceParticipant: vi.fn(),
  upsertVoiceSession: vi.fn(),
};

const resolveVoiceAgent = vi.fn();

vi.mock('../../db.js', () => dbFns);
vi.mock('./route-resolver.js', () => ({ resolveVoiceAgent }));

class FakeAdapter extends EventEmitter {
  platform = 'discord' as const;
  connect = vi.fn(async () => undefined);
  startDirectSession = vi.fn(async () => ({ sessionId: 'platform-session-1' }));
  joinExistingSession = vi.fn(async () => ({
    sessionId: 'platform-session-2',
  }));
  stopSession = vi.fn(async () => undefined);
  sendAudio = vi.fn(async () => undefined);
  interruptOutput = vi.fn(async () => undefined);
  onEvent(handler: (event: any) => void): void {
    this.on('event', handler);
  }
}

class FakeRealtimeSession extends EventEmitter {
  connect = vi.fn(async () => undefined);
  appendInputAudio = vi.fn(async () => undefined);
  interrupt = vi.fn(async () => undefined);
  sendToolResult = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  onEvent(handler: (event: any) => void): void {
    this.on('event', handler);
  }
}

describe('VoiceBridgeSessionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveVoiceAgent.mockResolvedValue({
      id: 'main',
      folder: 'main',
      name: 'Main',
      trigger: '@main',
      added_at: new Date().toISOString(),
      isMain: true,
    });
  });

  it('starts a voice session and bridges adapter and realtime events', async () => {
    const adapter = new FakeAdapter();
    const realtime = new FakeRealtimeSession();
    const { VoiceBridgeSessionManager } = await import('./session-manager.js');
    const manager = new VoiceBridgeSessionManager(
      {
        sendMessage: async () => undefined,
        schedulerDeps: {
          agents: async () => ({}),
          getSessions: async () => ({}),
          runAgent: async () => ({ status: 'success', result: 'ok' }),
          sendMessage: async () => undefined,
        },
      },
      {
        create: () => realtime as any,
      },
    );
    manager.registerAdapter(adapter as any);

    const record = await manager.startSession({
      platform: 'discord',
      mode: 'direct',
      targetId: 'user-1',
      routeKey: 'voice:discord:dm:user-1',
      participants: [{ participantId: 'user-1', displayName: 'User One' }],
      link: { textThreadId: 'discord:guild-1:thread-1' },
    });

    expect(record.agentId).toBe('main');
    expect(dbFns.upsertVoiceSession).toHaveBeenCalled();
    expect(realtime.connect).toHaveBeenCalled();

    adapter.emit('event', {
      type: 'audio.input',
      sessionId: 'platform-session-1',
      participantId: 'user-1',
      pcm16: Buffer.from('abc'),
      sampleRate: 24000,
    });

    expect(realtime.appendInputAudio).toHaveBeenCalled();

    realtime.emit('event', {
      type: 'audio.output',
      sessionId: record.voiceSessionId,
      pcm16: Buffer.from('def'),
      sampleRate: 24000,
    });

    expect(adapter.sendAudio).toHaveBeenCalledWith(
      'platform-session-1',
      Buffer.from('def'),
      24000,
    );

    realtime.emit('event', {
      type: 'tool.call',
      sessionId: record.voiceSessionId,
      callId: 'call-1',
      toolName: 'send_message',
      arguments: { text: 'hello' },
    });

    await vi.waitFor(() => {
      expect(realtime.sendToolResult).toHaveBeenCalled();
    });
  });
});
