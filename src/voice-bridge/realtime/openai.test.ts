import EventEmitter from 'events';

import { describe, expect, it, vi } from 'vitest';

import { OpenAIRealtimeSessionFactory } from './openai.js';

class FakeSocket extends EventEmitter {
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit('close');
  }
}

describe('OpenAI realtime session wrapper', () => {
  it('sends session setup and audio payloads', async () => {
    const socket = new FakeSocket();
    const factory = new OpenAIRealtimeSessionFactory(() => socket as any);
    const session = factory.create('voice-1');
    const events: unknown[] = [];
    session.onEvent((event) => {
      events.push(event);
    });

    const connectPromise = session.connect({
      sessionId: 'voice-1',
      model: 'gpt-realtime',
      instructions: 'Speak helpfully',
      voice: 'cedar',
      speed: 1,
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
      tools: [
        {
          name: 'send_message',
          description: 'Send message',
          inputSchema: { type: 'object' },
        },
      ],
    });
    socket.emit('open');
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'session.updated' })),
    );
    await connectPromise;

    expect(JSON.parse(socket.sent[0])).toEqual({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: 'Speak helpfully',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            noise_reduction: { type: 'far_field' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            voice: 'cedar',
            speed: 1,
          },
        },
        tools: [
          {
            type: 'function',
            name: 'send_message',
            description: 'Send message',
            parameters: { type: 'object' },
          },
        ],
      },
    });

    await session.appendInputAudio(Buffer.from('abc'), 24000);
    expect(socket.sent[1]).toContain('input_audio_buffer.append');

    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            call_id: 'call-1',
            name: 'send_message',
            arguments: JSON.stringify({ text: 'hello' }),
          },
        }),
      ),
    );

    expect(events).toContainEqual({
      type: 'tool.call',
      sessionId: 'voice-1',
      callId: 'call-1',
      toolName: 'send_message',
      arguments: { text: 'hello' },
    });
  });

  it('maps provider speech boundary events', async () => {
    const socket = new FakeSocket();
    const factory = new OpenAIRealtimeSessionFactory(() => socket as any);
    const session = factory.create('voice-1');
    const events: unknown[] = [];
    session.onEvent((event) => {
      events.push(event);
    });

    const connectPromise = session.connect({
      sessionId: 'voice-1',
      model: 'gpt-realtime',
      instructions: 'Speak helpfully',
      tools: [],
    });
    socket.emit('open');
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'session.updated' })),
    );
    await connectPromise;

    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'input_audio_buffer.speech_started',
          item_id: 'item-1',
          audio_start_ms: 120,
        }),
      ),
    );
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'input_audio_buffer.speech_stopped',
          item_id: 'item-1',
          audio_end_ms: 640,
        }),
      ),
    );

    expect(events).toContainEqual({
      type: 'speech.started',
      sessionId: 'voice-1',
      itemId: 'item-1',
      audioStartMs: 120,
    });
    expect(events).toContainEqual({
      type: 'speech.stopped',
      sessionId: 'voice-1',
      itemId: 'item-1',
      audioEndMs: 640,
    });
  });

  it('sends tool results back to the socket', async () => {
    const socket = new FakeSocket();
    const factory = new OpenAIRealtimeSessionFactory(() => socket as any);
    const session = factory.create('voice-1');

    const connectPromise = session.connect({
      sessionId: 'voice-1',
      model: 'gpt-realtime',
      instructions: 'Speak helpfully',
      tools: [],
    });
    socket.emit('open');
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'session.updated' })),
    );
    await connectPromise;

    await session.sendToolResult('call-1', { ok: true });
    expect(socket.sent[1]).toContain('function_call_output');
    expect(socket.sent[2]).toContain('response.create');
  });

  it('can inject a message back into realtime context', async () => {
    const socket = new FakeSocket();
    const factory = new OpenAIRealtimeSessionFactory(() => socket as any);
    const session = factory.create('voice-1');

    const connectPromise = session.connect({
      sessionId: 'voice-1',
      model: 'gpt-realtime',
      instructions: 'Speak helpfully',
      tools: [],
    });
    socket.emit('open');
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'session.updated' })),
    );
    await connectPromise;

    await session.addMessage('system', 'Background task completed.', {
      triggerResponse: true,
    });

    expect(socket.sent[1]).toContain('conversation.item.create');
    expect(socket.sent[1]).toContain('Background task completed.');
    expect(socket.sent[2]).toContain('response.create');
  });

  it('rejects connect when initial session update errors', async () => {
    const socket = new FakeSocket();
    const factory = new OpenAIRealtimeSessionFactory(() => socket as any);
    const session = factory.create('voice-1');

    const connectPromise = session.connect({
      sessionId: 'voice-1',
      model: 'gpt-realtime',
      instructions: 'Speak helpfully',
      tools: [],
    });

    socket.emit('open');
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'error',
          error: {
            message: 'Invalid session.update',
          },
        }),
      ),
    );

    await expect(connectPromise).rejects.toThrow('Invalid session.update');
  });
});
