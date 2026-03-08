import EventEmitter from 'events';
import WebSocket from 'ws';

import { logger } from '../../logger.js';
import {
  estimatePcmDurationMs,
  voiceStreamDiagnosticsEnabled,
} from '../diagnostics.js';
import type {
  RealtimeInputAudioConfig,
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
    },
  });
}

class OpenAIRealtimeSession implements RealtimeSession {
  private emitter = new EventEmitter();

  private socket: RealtimeSocketLike | null = null;

  private readonly activeResponseIds = new Set<string>();

  private audioOutputChunkCount = 0;

  private audioOutputBytes = 0;

  private responseAudioChunkCount = 0;

  private responseAudioBytes = 0;

  private currentResponseId?: string;

  private responseStartedAtMs?: number;

  private firstAudioChunkAtMs?: number;

  private lastAudioChunkAtMs?: number;

  private connectResolved = false;

  private connectResolve?: () => void;

  private connectReject?: (error: Error) => void;

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

      this.connectResolved = false;
      this.connectResolve = () => {
        if (settled || this.connectResolved) {
          return;
        }
        this.connectResolved = true;
        this.emitter.emit('event', {
          type: 'session.ready',
          sessionId: this.sessionId,
        } satisfies RealtimeEvent);
        settled = true;
        resolve();
      };
      this.connectReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      socket.on('open', () => {
        logger.info(
          { sessionId: this.sessionId, model: config.model },
          'OpenAI realtime socket opened',
        );
        socket.send(JSON.stringify(this.buildSessionUpdate(config)));
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
        this.connectReject?.(error);
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
        if (!this.connectResolved) {
          this.connectReject?.(
            new Error('OpenAI realtime socket closed before session was ready'),
          );
        }
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

  async addMessage(
    role: 'system' | 'user' | 'assistant',
    text: string,
    options?: { triggerResponse?: boolean },
  ): Promise<void> {
    this.assertSocket();
    logger.debug(
      {
        sessionId: this.sessionId,
        role,
        triggerResponse: options?.triggerResponse,
      },
      'Adding realtime conversation message',
    );

    this.socket!.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role,
          content: [
            {
              type: role === 'assistant' ? 'output_text' : 'input_text',
              text,
            },
          ],
        },
      }),
    );

    if (options?.triggerResponse) {
      this.socket!.send(JSON.stringify({ type: 'response.create' }));
    }
  }

  async close(): Promise<void> {
    logger.info(
      { sessionId: this.sessionId },
      'Closing OpenAI realtime session',
    );
    this.socket?.close();
    this.socket = null;
    this.connectResolved = false;
    this.connectResolve = undefined;
    this.connectReject = undefined;
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
    if (
      eventType !== 'response.audio.delta' &&
      eventType !== 'response.output_audio.delta'
    ) {
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
      case 'session.updated': {
        this.connectResolve?.();
        break;
      }
      case 'input_audio_buffer.speech_started': {
        this.emitter.emit('event', {
          type: 'speech.started',
          sessionId: this.sessionId,
          itemId: typeof event.item_id === 'string' ? event.item_id : undefined,
          audioStartMs:
            typeof event.audio_start_ms === 'number'
              ? event.audio_start_ms
              : undefined,
        } satisfies RealtimeEvent);
        break;
      }
      case 'input_audio_buffer.speech_stopped': {
        this.emitter.emit('event', {
          type: 'speech.stopped',
          sessionId: this.sessionId,
          itemId: typeof event.item_id === 'string' ? event.item_id : undefined,
          audioEndMs:
            typeof event.audio_end_ms === 'number'
              ? event.audio_end_ms
              : undefined,
        } satisfies RealtimeEvent);
        break;
      }
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
        this.currentResponseId = responseId;
        this.responseAudioChunkCount = 0;
        this.responseAudioBytes = 0;
        this.responseStartedAtMs = Date.now();
        this.firstAudioChunkAtMs = undefined;
        this.lastAudioChunkAtMs = undefined;
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
      case 'response.audio.delta':
      case 'response.output_audio.delta': {
        const audio = typeof event.delta === 'string' ? event.delta : '';
        const pcm16 = Buffer.from(audio, 'base64');
        const sampleRate =
          typeof event.sample_rate_hz === 'number'
            ? event.sample_rate_hz
            : 24000;
        const now = Date.now();
        const gapSincePreviousAudioChunkMs =
          typeof this.lastAudioChunkAtMs === 'number'
            ? now - this.lastAudioChunkAtMs
            : undefined;
        const latencyFromResponseStartedMs =
          typeof this.responseStartedAtMs === 'number' &&
          typeof this.firstAudioChunkAtMs !== 'number'
            ? now - this.responseStartedAtMs
            : undefined;

        this.audioOutputChunkCount += 1;
        this.audioOutputBytes += pcm16.length;
        this.responseAudioChunkCount += 1;
        this.responseAudioBytes += pcm16.length;
        this.firstAudioChunkAtMs ??= now;
        this.lastAudioChunkAtMs = now;

        if (voiceStreamDiagnosticsEnabled) {
          logger.info(
            {
              sessionId: this.sessionId,
              responseId:
                typeof event.response_id === 'string'
                  ? event.response_id
                  : this.currentResponseId,
              itemId:
                typeof event.item_id === 'string' ? event.item_id : undefined,
              outputIndex:
                typeof event.output_index === 'number'
                  ? event.output_index
                  : undefined,
              contentIndex:
                typeof event.content_index === 'number'
                  ? event.content_index
                  : undefined,
              audioChunkIndex: this.audioOutputChunkCount,
              responseAudioChunkIndex: this.responseAudioChunkCount,
              base64Chars: audio.length,
              pcmBytes: pcm16.length,
              sampleRate,
              estimatedDurationMs: estimatePcmDurationMs(
                pcm16.length,
                sampleRate,
              ),
              gapSincePreviousAudioChunkMs,
              latencyFromResponseStartedMs,
            },
            'OpenAI realtime audio delta received',
          );
        }

        this.emitter.emit('event', {
          type: 'audio.output',
          sessionId: this.sessionId,
          pcm16,
          sampleRate,
        } satisfies RealtimeEvent);
        break;
      }
      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done': {
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
            responseAudioChunkCount: this.responseAudioChunkCount,
            responseAudioBytes: this.responseAudioBytes,
            responseAudioDurationMs: estimatePcmDurationMs(
              this.responseAudioBytes,
              24000,
            ),
            timeToFirstAudioChunkMs:
              typeof this.responseStartedAtMs === 'number' &&
              typeof this.firstAudioChunkAtMs === 'number'
                ? this.firstAudioChunkAtMs - this.responseStartedAtMs
                : undefined,
          },
          'OpenAI realtime response finished',
        );
        this.currentResponseId = undefined;
        this.responseStartedAtMs = undefined;
        this.firstAudioChunkAtMs = undefined;
        this.lastAudioChunkAtMs = undefined;
        this.responseAudioChunkCount = 0;
        this.responseAudioBytes = 0;
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
          {
            sessionId: this.sessionId,
            responseId,
            responseAudioChunkCount: this.responseAudioChunkCount,
            responseAudioBytes: this.responseAudioBytes,
          },
          'OpenAI realtime response cancelled',
        );
        this.currentResponseId = undefined;
        this.responseStartedAtMs = undefined;
        this.firstAudioChunkAtMs = undefined;
        this.lastAudioChunkAtMs = undefined;
        this.responseAudioChunkCount = 0;
        this.responseAudioBytes = 0;
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
        if (!this.connectResolved) {
          this.connectReject?.(new Error(errorMessage));
        }
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

  private buildSessionUpdate(
    config: RealtimeSessionConfig,
  ): Record<string, unknown> {
    const inputSampleRate = config.inputAudio?.sampleRate ?? 24000;
    const outputSampleRate = config.outputAudio?.sampleRate ?? 24000;
    const inputAudio = this.buildInputAudioConfig(config.inputAudio);
    const outputAudio: Record<string, unknown> = {
      format: {
        type: 'audio/pcm',
        rate: outputSampleRate,
      },
    };

    if (config.voice) {
      outputAudio.voice = config.voice;
    }

    if (typeof config.speed === 'number') {
      outputAudio.speed = config.speed;
    }

    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: config.instructions,
        audio: {
          input: {
            format: {
              type: 'audio/pcm',
              rate: inputSampleRate,
            },
            ...inputAudio,
          },
          output: outputAudio,
        },
        tools: config.tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        })),
      },
    };
  }

  private buildInputAudioConfig(
    config?: RealtimeInputAudioConfig,
  ): Record<string, unknown> {
    const inputAudio: Record<string, unknown> = {};

    if (config?.noiseReduction) {
      inputAudio.noise_reduction = { type: config.noiseReduction };
    }

    if (config?.transcriptionModel) {
      inputAudio.transcription = { model: config.transcriptionModel };
    }

    if (config?.turnDetection) {
      inputAudio.turn_detection = {
        type: config.turnDetection.type,
        threshold: config.turnDetection.threshold,
        prefix_padding_ms: config.turnDetection.prefixPaddingMs,
        silence_duration_ms: config.turnDetection.silenceDurationMs,
        create_response: config.turnDetection.createResponse,
        interrupt_response: config.turnDetection.interruptResponse,
      };
    } else if (config?.turnDetection === null) {
      inputAudio.turn_detection = null;
    }

    return inputAudio;
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
