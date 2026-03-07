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
      tools: [
        {
          name: 'send_message',
          description: 'Send message',
          inputSchema: { type: 'object' },
        },
      ],
    });
    socket.emit('open');
    await connectPromise;

    expect(socket.sent[0]).toContain('session.update');

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
    await connectPromise;

    await session.addMessage('system', 'Background task completed.', {
      triggerResponse: true,
    });

    expect(socket.sent[1]).toContain('conversation.item.create');
    expect(socket.sent[1]).toContain('Background task completed.');
    expect(socket.sent[2]).toContain('response.create');
  });
});
