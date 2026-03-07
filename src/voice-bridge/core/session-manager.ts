import EventEmitter from 'events';

import {
  appendVoiceTranscript,
  markVoiceParticipantLeft,
  markVoiceSessionEnded,
  upsertVoiceParticipant,
  upsertVoiceSession,
} from '../../db.js';
import { logger } from '../../logger.js';
import type { Agent } from '../../types.js';
import { createRealtimeToolBridge } from '../realtime/nanoclaw-tools.js';
import {
  RealtimeSessionFactory,
  VoiceBridgeDependencies,
  VoicePlatform,
  VoicePlatformAdapter,
  VoiceSessionRecord,
  VoiceSessionRequest,
} from '../types.js';
import { buildVoiceSystemPrompt } from './prompt-loader.js';
import { resolveVoiceAgent } from './route-resolver.js';

export interface VoiceBridgeStartedEvent {
  type: 'voice.session.started';
  session: VoiceSessionRecord;
}

export interface VoiceBridgeEndedEvent {
  type: 'voice.session.ended';
  voiceSessionId: string;
  reason?: string;
}

export type VoiceBridgeEvent = VoiceBridgeStartedEvent | VoiceBridgeEndedEvent;

interface ActiveVoiceSession {
  record: VoiceSessionRecord;
  adapter: VoicePlatformAdapter;
  realtime: ReturnType<RealtimeSessionFactory['create']>;
}

export class VoiceBridgeSessionManager {
  private readonly emitter = new EventEmitter();

  private readonly adapters = new Map<VoicePlatform, VoicePlatformAdapter>();

  private readonly activeSessions = new Map<string, ActiveVoiceSession>();

  constructor(
    private readonly deps: VoiceBridgeDependencies,
    private readonly realtimeFactory: RealtimeSessionFactory,
  ) {}

  registerAdapter(adapter: VoicePlatformAdapter): void {
    this.adapters.set(adapter.platform, adapter);
    adapter.onEvent((event) => {
      void this.handleAdapterEvent(adapter.platform, event);
    });
  }

  async connectAdapters(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.connect();
    }
  }

  async startSession(
    request: VoiceSessionRequest,
  ): Promise<VoiceSessionRecord> {
    const adapter = this.adapters.get(request.platform);
    if (!adapter) {
      throw new Error(`No voice adapter registered for ${request.platform}`);
    }

    const agent = await this.getAgentOrThrow(request.routeKey);
    const platformSession =
      request.mode === 'direct'
        ? await adapter.startDirectSession(request.targetId)
        : await adapter.joinExistingSession(request.targetId);

    const record = await this.createVoiceSessionRecord({
      adapter,
      agent,
      platformSessionId: platformSession.sessionId,
      request,
    });

    return record;
  }

  async stopSession(voiceSessionId: string): Promise<void> {
    const active = this.activeSessions.get(voiceSessionId);
    if (!active) {
      return;
    }

    await active.realtime.close();
    await active.adapter.stopSession(active.record.platformSessionId);
    markVoiceSessionEnded(voiceSessionId, 'ended');
    this.activeSessions.delete(voiceSessionId);
    this.emitter.emit('event', {
      type: 'voice.session.ended',
      voiceSessionId,
    } satisfies VoiceBridgeEvent);
  }

  onEvent(handler: (event: VoiceBridgeEvent) => void): void {
    this.emitter.on('event', handler);
  }

  listActiveSessions(): VoiceSessionRecord[] {
    return Array.from(this.activeSessions.values()).map(
      (session) => session.record,
    );
  }

  findActiveSessionByPlatform(
    platform: VoiceSessionRecord['platform'],
    platformSessionId: string,
  ): VoiceSessionRecord | null {
    for (const active of this.activeSessions.values()) {
      if (
        active.record.platform === platform &&
        active.record.platformSessionId === platformSessionId
      ) {
        return active.record;
      }
    }

    return null;
  }

  private async createVoiceSessionRecord(input: {
    adapter: VoicePlatformAdapter;
    agent: Agent;
    platformSessionId: string;
    request: VoiceSessionRequest;
  }): Promise<VoiceSessionRecord> {
    const voiceSessionId = `${input.request.platform}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const effectivePrompt = buildVoiceSystemPrompt({
      agentId: input.agent.id,
      isMain: Boolean(input.agent.isMain),
      routeKey: input.request.routeKey,
    });
    const record: VoiceSessionRecord = {
      voiceSessionId,
      platform: input.request.platform,
      platformSessionId: input.platformSessionId,
      routeKey: input.request.routeKey,
      agentId: input.agent.id,
      effectivePrompt,
      status: 'active',
      startedBy: input.request.startedBy,
      startedAt: new Date().toISOString(),
      linkedTextThreadId: input.request.link?.textThreadId,
      linkedTextSessionId: input.request.link?.textSessionId,
      metadata: input.request.metadata,
    };

    upsertVoiceSession(record);

    for (const participant of input.request.participants ?? []) {
      await upsertVoiceParticipant({
        voiceSessionId,
        participantId: participant.participantId,
        displayName: participant.displayName,
        joinedAt: record.startedAt,
      });
    }

    const realtime = this.realtimeFactory.create(voiceSessionId);
    const toolBridge = createRealtimeToolBridge({
      agentId: input.agent.id,
      isMain: Boolean(input.agent.isMain),
      routeKey: record.routeKey,
      linkedTextThreadId: record.linkedTextThreadId,
      deps: {
        sendMessage: this.deps.sendMessage,
        schedulerDeps: this.deps.schedulerDeps,
      },
    });

    realtime.onEvent((event) => {
      void this.handleRealtimeEvent(record.voiceSessionId, event, toolBridge);
    });

    await realtime.connect({
      sessionId: voiceSessionId,
      model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime',
      voice: process.env.OPENAI_REALTIME_VOICE || 'alloy',
      instructions: effectivePrompt,
      tools: toolBridge.definitions,
    });

    this.activeSessions.set(voiceSessionId, {
      record,
      adapter: input.adapter,
      realtime,
    });

    this.emitter.emit('event', {
      type: 'voice.session.started',
      session: record,
    } satisfies VoiceBridgeEvent);

    return record;
  }

  private async handleAdapterEvent(
    platform: VoicePlatform,
    event: Parameters<VoicePlatformAdapter['onEvent']>[0] extends (
      event: infer T,
    ) => void
      ? T
      : never,
  ): Promise<void> {
    const active = Array.from(this.activeSessions.values()).find(
      (session) =>
        session.record.platform === platform &&
        session.record.platformSessionId === event.sessionId,
    );

    if (!active) {
      return;
    }

    switch (event.type) {
      case 'participant.joined':
        await upsertVoiceParticipant({
          voiceSessionId: active.record.voiceSessionId,
          participantId: event.participantId,
          displayName: event.displayName,
          joinedAt: new Date().toISOString(),
        });
        break;
      case 'participant.left':
        markVoiceParticipantLeft(
          active.record.voiceSessionId,
          event.participantId,
        );
        break;
      case 'audio.input':
        await active.realtime.appendInputAudio(event.pcm16, event.sampleRate);
        break;
      case 'speech.started':
        await active.realtime.interrupt();
        await active.adapter.interruptOutput(active.record.platformSessionId);
        break;
      case 'transcript.final':
        appendVoiceTranscript({
          voiceSessionId: active.record.voiceSessionId,
          participantId: event.participantId,
          role: event.role,
          content: event.text,
          createdAt: new Date().toISOString(),
        });
        break;
      case 'session.ended':
        await this.stopSession(active.record.voiceSessionId);
        break;
      default:
        break;
    }
  }

  private async handleRealtimeEvent(
    voiceSessionId: string,
    event: Parameters<
      ReturnType<RealtimeSessionFactory['create']>['onEvent']
    >[0] extends (event: infer T) => void
      ? T
      : never,
    toolBridge: ReturnType<typeof createRealtimeToolBridge>,
  ): Promise<void> {
    const active = this.activeSessions.get(voiceSessionId);
    if (!active) {
      return;
    }

    switch (event.type) {
      case 'audio.output':
        await active.adapter.sendAudio(
          active.record.platformSessionId,
          event.pcm16,
          event.sampleRate,
        );
        break;
      case 'transcript.final':
        appendVoiceTranscript({
          voiceSessionId,
          role: event.role,
          content: event.text,
          createdAt: new Date().toISOString(),
        });
        break;
      case 'tool.call': {
        const result = await toolBridge.execute(
          event.toolName,
          event.arguments,
        );
        await active.realtime.sendToolResult(event.callId, result);
        break;
      }
      case 'session.error':
        logger.error(
          { voiceSessionId, error: event.error },
          'Realtime voice session failed',
        );
        markVoiceSessionEnded(voiceSessionId, 'failed');
        break;
      case 'session.closed':
        markVoiceSessionEnded(voiceSessionId, 'ended');
        this.activeSessions.delete(voiceSessionId);
        break;
      default:
        break;
    }
  }

  private async getAgentOrThrow(routeKey: string): Promise<Agent> {
    const agent = await resolveVoiceAgent(routeKey);
    if (!agent) {
      throw new Error(`No agent configured for voice route ${routeKey}`);
    }
    return agent;
  }
}
