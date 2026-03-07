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

  private readonly activeResponseIds = new Set<string>();

  constructor(
    private readonly sessionId: string,
    private readonly socketFactory: RealtimeSocketFactory,
  ) {}

  async connect(config: RealtimeSessionConfig): Promise<void> {
    if (this.socket) {
      logger.debug(
        { sessionId: this.sessionId },
        'Realtime session already connected',
      );
      return;
    }

    const url = new URL('wss://api.openai.com/v1/realtime');
    url.searchParams.set('model', config.model);

    logger.info(
      {
        sessionId: this.sessionId,
        model: config.model,
        voice: config.voice,
        speed: config.speed,
        toolCount: config.tools.length,
      },
      'Connecting OpenAI realtime session',
    );

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = this.socketFactory(url.toString());
      this.socket = socket;

      socket.on('open', () => {
        logger.info(
          { sessionId: this.sessionId, model: config.model },
          'OpenAI realtime socket opened',
        );
        socket.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              instructions: config.instructions,
              voice: config.voice,
              speed: config.speed,
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
        logger.info(
          { sessionId: this.sessionId },
          'OpenAI realtime socket closed',
        );
        this.emitter.emit('event', {
          type: 'session.closed',
          sessionId: this.sessionId,
        } satisfies RealtimeEvent);
      });
    });
  }

  async appendInputAudio(pcm16: Buffer, sampleRate: number): Promise<void> {
    this.assertSocket();
    void sampleRate;
    this.socket!.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: pcm16.toString('base64'),
      }),
    );
  }

  async interrupt(): Promise<void> {
    this.assertSocket();
    logger.debug({ sessionId: this.sessionId }, 'Cancelling realtime response');
    this.socket!.send(JSON.stringify({ type: 'response.cancel' }));
  }

  async sendToolResult(callId: string, result: unknown): Promise<void> {
    this.assertSocket();
    logger.debug(
      { sessionId: this.sessionId, callId },
      'Sending realtime tool result to model',
    );
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
    logger.info(
      { sessionId: this.sessionId },
      'Closing OpenAI realtime session',
    );
    this.socket?.close();
    this.socket = null;
  }

  onEvent(handler: (event: RealtimeEvent) => void): void {
    this.emitter.on('event', handler);
  }

  private handleMessage(raw: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      logger.error(
        { err: error, sessionId: this.sessionId },
        'Failed to parse OpenAI realtime event payload',
      );
      return;
    }

    const eventType = typeof event.type === 'string' ? event.type : 'unknown';
    if (eventType !== 'response.audio.delta') {
      logger.debug(
        {
          sessionId: this.sessionId,
          eventType,
          event: this.summarizeRealtimeEvent(event),
        },
        'OpenAI realtime event received',
      );
    }

    switch (event.type) {
      case 'response.created': {
        const response =
          typeof event.response === 'object' && event.response !== null
            ? (event.response as Record<string, unknown>)
            : null;
        const status =
          response && typeof response.status === 'string'
            ? response.status
            : undefined;
        const responseId =
          response && typeof response.id === 'string' ? response.id : undefined;
        if (responseId) {
          this.activeResponseIds.add(responseId);
        }
        logger.info(
          {
            sessionId: this.sessionId,
            responseId,
            status,
          },
          'OpenAI realtime response started',
        );
        this.emitter.emit('event', {
          type: 'response.started',
          sessionId: this.sessionId,
          responseId,
          status,
        } satisfies RealtimeEvent);
        break;
      }
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
      case 'response.done': {
        const response =
          typeof event.response === 'object' && event.response !== null
            ? (event.response as Record<string, unknown>)
            : null;
        const status =
          response && typeof response.status === 'string'
            ? response.status
            : undefined;
        const responseId =
          response && typeof response.id === 'string' ? response.id : undefined;
        if (responseId) {
          this.activeResponseIds.delete(responseId);
        }
        logger.info(
          {
            sessionId: this.sessionId,
            responseId,
            status,
          },
          'OpenAI realtime response finished',
        );
        this.emitter.emit('event', {
          type: 'response.finished',
          sessionId: this.sessionId,
          responseId,
          status,
        } satisfies RealtimeEvent);
        break;
      }
      case 'response.output_item.done': {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === 'function_call') {
          logger.info(
            {
              sessionId: this.sessionId,
              toolName: item.name,
              callId: item.call_id,
            },
            'OpenAI realtime requested tool call',
          );
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
        const responseId =
          typeof event.response_id === 'string' ? event.response_id : undefined;
        if (responseId) {
          this.activeResponseIds.delete(responseId);
        }
        logger.debug(
          { sessionId: this.sessionId, responseId },
          'OpenAI realtime response cancelled',
        );
        this.emitter.emit('event', {
          type: 'response.interrupted',
          sessionId: this.sessionId,
        } satisfies RealtimeEvent);
        break;
      }
      case 'error': {
        const errorPayload =
          typeof event.error === 'object' && event.error !== null
            ? (event.error as Record<string, unknown>)
            : null;
        const errorCode =
          errorPayload && typeof errorPayload.code === 'string'
            ? errorPayload.code
            : undefined;
        const errorMessage =
          errorPayload && typeof errorPayload.message === 'string'
            ? errorPayload.message
            : typeof event.message === 'string'
              ? event.message
              : 'Unknown error';

        if (errorCode === 'response_cancel_not_active') {
          logger.debug(
            { sessionId: this.sessionId, event },
            'OpenAI realtime response cancel ignored (no active response)',
          );
          break;
        }

        logger.error(
          { sessionId: this.sessionId, event },
          'OpenAI realtime API returned an error event',
        );
        this.emitter.emit('event', {
          type: 'session.error',
          sessionId: this.sessionId,
          error: errorMessage,
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

  private summarizeRealtimeEvent(
    event: Record<string, unknown>,
  ): Record<string, unknown> {
    const summary: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event)) {
      if (key === 'delta' && typeof value === 'string' && value.length > 120) {
        summary[key] = `<omitted:${value.length} chars>`;
        continue;
      }
      if (key === 'audio' && typeof value === 'string') {
        summary[key] = `<omitted:${value.length} chars>`;
        continue;
      }
      summary[key] = value;
    }
    return summary;
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
