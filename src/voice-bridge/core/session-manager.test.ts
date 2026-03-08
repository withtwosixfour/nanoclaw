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
const executeTool = vi.fn(
  async (): Promise<Record<string, unknown>> => ({
    ok: true,
  }),
);

vi.mock('../../db.js', () => dbFns);
vi.mock('./route-resolver.js', () => ({ resolveVoiceAgent }));
vi.mock('../realtime/nanoclaw-tools.js', () => ({
  createRealtimeToolBridge: vi.fn(() => ({
    definitions: [],
    execute: executeTool,
  })),
  isLeaveCallToolResult: vi.fn(
    (value: unknown) =>
      typeof value === 'object' &&
      value !== null &&
      'leaveCall' in value &&
      (value as { leaveCall?: unknown }).leaveCall === true,
  ),
}));

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
  addMessage = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  onEvent(handler: (event: any) => void): void {
    this.on('event', handler);
  }
}

describe('VoiceBridgeSessionManager', () => {
  beforeEach(() => {
    dbFns.appendVoiceTranscript.mockReset();
    dbFns.markVoiceParticipantLeft.mockReset();
    dbFns.markVoiceSessionEnded.mockReset();
    dbFns.upsertVoiceParticipant.mockReset();
    dbFns.upsertVoiceSession.mockReset();
    resolveVoiceAgent.mockReset();
    executeTool.mockReset();
    executeTool.mockResolvedValue({ ok: true });
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
        create: () => realtime,
      },
    );
    manager.registerAdapter(adapter);

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
    expect(realtime.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        inputAudio: {
          noiseReduction: 'far_field',
          turnDetection: {
            type: 'server_vad',
            threshold: 0.5,
            prefixPaddingMs: 300,
            silenceDurationMs: 500,
            createResponse: true,
            interruptResponse: true,
          },
        },
        outputAudio: {
          sampleRate: 24000,
        },
      }),
    );

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
      expect(executeTool).toHaveBeenCalledWith('send_message', {
        text: 'hello',
      });
      expect(realtime.sendToolResult).toHaveBeenCalled();
    });
  });

  it('accepts adapter audio while realtime is still connecting', async () => {
    const adapter = new FakeAdapter();
    const realtime = new FakeRealtimeSession();
    let resolveConnect: (() => void) | undefined;
    realtime.connect = vi.fn(
      async () =>
        await new Promise<undefined>((resolve) => {
          resolveConnect = () => resolve(undefined);
        }),
    );

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

    const startPromise = manager.startSession({
      platform: 'discord',
      mode: 'direct',
      targetId: 'user-1',
      routeKey: 'voice:discord:dm:user-1',
    });

    await vi.waitFor(() => {
      expect(realtime.connect).toHaveBeenCalled();
    });

    adapter.emit('event', {
      type: 'audio.input',
      sessionId: 'platform-session-1',
      participantId: 'user-1',
      pcm16: Buffer.from('abc'),
      sampleRate: 24000,
    });

    await vi.waitFor(() => {
      expect(realtime.appendInputAudio).toHaveBeenCalledWith(
        Buffer.from('abc'),
        24000,
      );
    });

    resolveConnect?.();
    await startPromise;
  });

  it('leaves the call when the realtime model requests it', async () => {
    executeTool.mockResolvedValueOnce({
      ok: true,
      leaveCall: true,
      message: 'Leaving the call now.',
    });

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
    });

    realtime.emit('event', {
      type: 'tool.call',
      sessionId: record.voiceSessionId,
      callId: 'call-leave',
      toolName: 'leave_call',
      arguments: {},
    });

    await vi.waitFor(() => {
      expect(realtime.sendToolResult).toHaveBeenCalledWith(
        'call-leave',
        expect.objectContaining({ leaveCall: true }),
      );
      expect(realtime.close).toHaveBeenCalled();
      expect(adapter.stopSession).toHaveBeenCalledWith('platform-session-1');
    });
  });

  it('interrupts Discord output when realtime speech starts', async () => {
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
    });

    realtime.emit('event', {
      type: 'speech.started',
      sessionId: record.voiceSessionId,
      itemId: 'item-1',
      audioStartMs: 120,
    });

    await vi.waitFor(() => {
      expect(adapter.interruptOutput).toHaveBeenCalledWith(
        'platform-session-1',
      );
    });
    expect(realtime.interrupt).not.toHaveBeenCalled();
  });
});
