import EventEmitter from 'events';

import type {
  VoiceEvent,
  VoicePlatformAdapter,
  VoicePlatform,
} from '../types.js';

export interface SlackHuddlesTransport {
  connect(): Promise<void>;
  startDirectSession(targetId: string): Promise<{ sessionId: string }>;
  joinExistingSession(targetId: string): Promise<{ sessionId: string }>;
  stopSession(sessionId: string): Promise<void>;
  sendAudio(
    sessionId: string,
    pcm16: Buffer,
    sampleRate: number,
  ): Promise<void>;
  interruptOutput(sessionId: string): Promise<void>;
  onEvent(handler: (event: VoiceEvent) => void): void;
}

export class SlackHuddlesAdapter implements VoicePlatformAdapter {
  readonly platform: VoicePlatform = 'slack';

  private emitter = new EventEmitter();

  constructor(private readonly transport: SlackHuddlesTransport) {
    this.transport.onEvent((event) => {
      this.emitter.emit('event', event);
    });
  }

  async connect(): Promise<void> {
    await this.transport.connect();
  }

  async startDirectSession(targetId: string): Promise<{ sessionId: string }> {
    return await this.transport.startDirectSession(targetId);
  }

  async joinExistingSession(targetId: string): Promise<{ sessionId: string }> {
    return await this.transport.joinExistingSession(targetId);
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.transport.stopSession(sessionId);
  }

  async sendAudio(
    sessionId: string,
    pcm16: Buffer,
    sampleRate: number,
  ): Promise<void> {
    await this.transport.sendAudio(sessionId, pcm16, sampleRate);
  }

  async interruptOutput(sessionId: string): Promise<void> {
    await this.transport.interruptOutput(sessionId);
  }

  onEvent(handler: (event: VoiceEvent) => void): void {
    this.emitter.on('event', handler);
  }
}
