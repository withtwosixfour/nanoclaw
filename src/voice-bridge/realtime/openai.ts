import EventEmitter from 'events';
import WebSocket from 'ws';

import { logger } from '../../logger.js';
import type {
  RealtimeEvent,
  RealtimeSession,
  RealtimeSessionConfig,
  RealtimeSessionFactory,
} from '../types.js';

interface RealtimeSocketLike {
  send(data: string): void;
  close(): void;
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: WebSocket.RawData) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: () => void): void;
}

export type RealtimeSocketFactory = (url: string) => RealtimeSocketLike;

function defaultSocketFactory(url: string): RealtimeSocketLike {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for realtime voice sessions');
  }

  return new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'OpenAI-Beta': 'realtime=v1',
    },
  });
}

class OpenAIRealtimeSession implements RealtimeSession {
  private emitter = new EventEmitter();

  private socket: RealtimeSocketLike | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly socketFactory: RealtimeSocketFactory,
  ) {}

  async connect(config: RealtimeSessionConfig): Promise<void> {
    if (this.socket) {
      return;
    }

    const url = new URL('wss://api.openai.com/v1/realtime');
    url.searchParams.set('model', config.model);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = this.socketFactory(url.toString());
      this.socket = socket;

      socket.on('open', () => {
        socket.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              instructions: config.instructions,
              voice: config.voice,
              tools: config.tools.map((tool) => ({
                type: 'function',
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              })),
            },
          }),
        );
        this.emitter.emit('event', {
          type: 'session.ready',
          sessionId: this.sessionId,
        } satisfies RealtimeEvent);
        settled = true;
        resolve();
      });

      socket.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      socket.on('error', (error) => {
        logger.error(
          { err: error, sessionId: this.sessionId },
          'Realtime error',
        );
        this.emitter.emit('event', {
          type: 'session.error',
          sessionId: this.sessionId,
          error: error.message,
        } satisfies RealtimeEvent);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      socket.on('close', () => {
        this.emitter.emit('event', {
          type: 'session.closed',
          sessionId: this.sessionId,
        } satisfies RealtimeEvent);
      });
    });
  }

  async appendInputAudio(pcm16: Buffer, sampleRate: number): Promise<void> {
    this.assertSocket();
    this.socket!.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: pcm16.toString('base64'),
        sample_rate_hz: sampleRate,
      }),
    );
  }

  async interrupt(): Promise<void> {
    this.assertSocket();
    this.socket!.send(JSON.stringify({ type: 'response.cancel' }));
  }

  async sendToolResult(callId: string, result: unknown): Promise<void> {
    this.assertSocket();
    this.socket!.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify(result),
        },
      }),
    );
    this.socket!.send(JSON.stringify({ type: 'response.create' }));
  }

  async close(): Promise<void> {
    this.socket?.close();
    this.socket = null;
  }

  onEvent(handler: (event: RealtimeEvent) => void): void {
    this.emitter.on('event', handler);
  }

  private handleMessage(raw: string): void {
    const event = JSON.parse(raw) as Record<string, unknown>;
    switch (event.type) {
      case 'response.audio.delta': {
        const audio = typeof event.delta === 'string' ? event.delta : '';
        this.emitter.emit('event', {
          type: 'audio.output',
          sessionId: this.sessionId,
          pcm16: Buffer.from(audio, 'base64'),
          sampleRate:
            typeof event.sample_rate_hz === 'number'
              ? event.sample_rate_hz
              : 24000,
        } satisfies RealtimeEvent);
        break;
      }
      case 'response.audio_transcript.done': {
        this.emitter.emit('event', {
          type: 'transcript.final',
          sessionId: this.sessionId,
          role: 'assistant',
          text: typeof event.transcript === 'string' ? event.transcript : '',
        } satisfies RealtimeEvent);
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        this.emitter.emit('event', {
          type: 'transcript.final',
          sessionId: this.sessionId,
          role: 'user',
          text: typeof event.transcript === 'string' ? event.transcript : '',
        } satisfies RealtimeEvent);
        break;
      }
      case 'response.output_item.done': {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === 'function_call') {
          this.emitter.emit('event', {
            type: 'tool.call',
            sessionId: this.sessionId,
            callId: typeof item.call_id === 'string' ? item.call_id : '',
            toolName: typeof item.name === 'string' ? item.name : '',
            arguments:
              typeof item.arguments === 'string'
                ? (JSON.parse(item.arguments) as Record<string, unknown>)
                : {},
          } satisfies RealtimeEvent);
        }
        break;
      }
      case 'response.cancelled': {
        this.emitter.emit('event', {
          type: 'response.interrupted',
          sessionId: this.sessionId,
        } satisfies RealtimeEvent);
        break;
      }
      case 'error': {
        this.emitter.emit('event', {
          type: 'session.error',
          sessionId: this.sessionId,
          error:
            typeof event.message === 'string' ? event.message : 'Unknown error',
        } satisfies RealtimeEvent);
        break;
      }
      default:
        break;
    }
  }

  private assertSocket(): void {
    if (!this.socket) {
      throw new Error('Realtime session is not connected');
    }
  }
}

export class OpenAIRealtimeSessionFactory implements RealtimeSessionFactory {
  constructor(
    private readonly socketFactory: RealtimeSocketFactory = defaultSocketFactory,
  ) {}

  create(sessionId: string): RealtimeSession {
    return new OpenAIRealtimeSession(sessionId, this.socketFactory);
  }
}
