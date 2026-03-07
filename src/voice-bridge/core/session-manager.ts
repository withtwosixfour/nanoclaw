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
import {
  estimatePcmDurationMs,
  voiceStreamDiagnosticsEnabled,
} from '../diagnostics.js';
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

interface OutputDispatchDiagnostics {
  chunkCount: number;
  totalBytes: number;
  responseStartedAtMs?: number;
  firstChunkAtMs?: number;
  lastChunkAtMs?: number;
}

export class VoiceBridgeSessionManager {
  private readonly emitter = new EventEmitter();

  private readonly adapters = new Map<VoicePlatform, VoicePlatformAdapter>();

  private readonly activeSessions = new Map<string, ActiveVoiceSession>();

  private readonly lastSpeechStoppedAtMs = new Map<string, number>();

  private readonly pendingSpeechInterrupts = new Map<string, NodeJS.Timeout>();

  private readonly activeResponseBySession = new Map<string, boolean>();

  private readonly outputDiagnosticsBySession = new Map<
    string,
    OutputDispatchDiagnostics
  >();

  private static readonly SPEECH_INTERRUPT_DEBOUNCE_MS = 250;

  constructor(
    private readonly deps: VoiceBridgeDependencies,
    private readonly realtimeFactory: RealtimeSessionFactory,
  ) {}

  registerAdapter(adapter: VoicePlatformAdapter): void {
    logger.info({ platform: adapter.platform }, 'Registering voice adapter');
    this.adapters.set(adapter.platform, adapter);
    adapter.onEvent((event) => {
      void this.handleAdapterEvent(adapter.platform, event);
    });
  }

  async connectAdapters(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      logger.info({ platform: adapter.platform }, 'Connecting voice adapter');
      await adapter.connect();
      logger.info({ platform: adapter.platform }, 'Voice adapter connected');
    }
  }

  async startSession(
    request: VoiceSessionRequest,
  ): Promise<VoiceSessionRecord> {
    const adapter = this.adapters.get(request.platform);
    if (!adapter) {
      logger.error(
        { platform: request.platform, routeKey: request.routeKey },
        'Voice session requested without a registered adapter',
      );
      throw new Error(`No voice adapter registered for ${request.platform}`);
    }

    logger.info(
      {
        platform: request.platform,
        mode: request.mode,
        targetId: request.targetId,
        routeKey: request.routeKey,
        startedBy: request.startedBy,
      },
      'Starting voice session',
    );

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
      logger.warn(
        { voiceSessionId },
        'Attempted to stop unknown voice session',
      );
      return;
    }

    logger.info(
      {
        voiceSessionId,
        platform: active.record.platform,
        platformSessionId: active.record.platformSessionId,
        routeKey: active.record.routeKey,
      },
      'Stopping voice session',
    );

    await active.realtime.close();
    await active.adapter.stopSession(active.record.platformSessionId);
    markVoiceSessionEnded(voiceSessionId, 'ended');
    this.clearSessionSpeechState(voiceSessionId);
    this.lastSpeechStoppedAtMs.delete(voiceSessionId);
    this.activeResponseBySession.delete(voiceSessionId);
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

    logger.info(
      {
        voiceSessionId,
        platform: record.platform,
        platformSessionId: record.platformSessionId,
        routeKey: record.routeKey,
        agentId: record.agentId,
        participantCount: input.request.participants?.length ?? 0,
        linkedTextThreadId: record.linkedTextThreadId,
      },
      'Created voice session record',
    );

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

    const params = {
      sessionId: voiceSessionId,
      model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-1.5',
      voice: process.env.OPENAI_REALTIME_VOICE || 'cedar',
      input_audio_noise_reduction: 'far_field',
      instructions: effectivePrompt,
      tools: toolBridge.definitions,
    };

    await realtime.connect(params);

    logger.info(params, 'Realtime voice session connected');

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
      logger.debug(
        { platform, platformSessionId: event.sessionId, eventType: event.type },
        'Ignoring adapter event for unknown voice session',
      );
      return;
    }

    switch (event.type) {
      case 'participant.joined':
        logger.info(
          {
            voiceSessionId: active.record.voiceSessionId,
            participantId: event.participantId,
            displayName: event.displayName,
          },
          'Voice participant joined',
        );
        await upsertVoiceParticipant({
          voiceSessionId: active.record.voiceSessionId,
          participantId: event.participantId,
          displayName: event.displayName,
          joinedAt: new Date().toISOString(),
        });
        break;
      case 'participant.left':
        logger.info(
          {
            voiceSessionId: active.record.voiceSessionId,
            participantId: event.participantId,
          },
          'Voice participant left',
        );
        markVoiceParticipantLeft(
          active.record.voiceSessionId,
          event.participantId,
        );
        break;
      case 'audio.input':
        await active.realtime.appendInputAudio(event.pcm16, event.sampleRate);
        break;
      case 'speech.started':
        this.scheduleSpeechInterrupt(
          active.record.voiceSessionId,
          event.participantId,
        );
        logger.debug(
          {
            voiceSessionId: active.record.voiceSessionId,
            participantId: event.participantId,
            debounceMs: VoiceBridgeSessionManager.SPEECH_INTERRUPT_DEBOUNCE_MS,
          },
          'User speech started; scheduling assistant interruption',
        );
        break;
      case 'speech.stopped':
        this.clearPendingSpeechInterrupt(
          active.record.voiceSessionId,
          event.participantId,
        );
        this.lastSpeechStoppedAtMs.set(
          active.record.voiceSessionId,
          Date.now(),
        );
        logger.debug(
          {
            voiceSessionId: active.record.voiceSessionId,
            participantId: event.participantId,
          },
          'User speech stopped',
        );
        break;
      case 'transcript.final':
        logger.debug(
          {
            voiceSessionId: active.record.voiceSessionId,
            participantId: event.participantId,
            role: event.role,
            length: event.text.length,
          },
          'Persisting adapter transcript entry',
        );
        appendVoiceTranscript({
          voiceSessionId: active.record.voiceSessionId,
          participantId: event.participantId,
          role: event.role,
          content: event.text,
          createdAt: new Date().toISOString(),
        });
        break;
      case 'session.ended':
        logger.warn(
          {
            voiceSessionId: active.record.voiceSessionId,
            reason: event.reason,
          },
          'Platform voice session ended',
        );
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
      logger.debug(
        { voiceSessionId, eventType: event.type },
        'Ignoring realtime event for unknown voice session',
      );
      return;
    }

    switch (event.type) {
      case 'response.started': {
        this.activeResponseBySession.set(voiceSessionId, true);
        this.outputDiagnosticsBySession.set(voiceSessionId, {
          chunkCount: 0,
          totalBytes: 0,
          responseStartedAtMs: Date.now(),
        });
        const speechStoppedAt = this.lastSpeechStoppedAtMs.get(voiceSessionId);
        const latencyMs =
          typeof speechStoppedAt === 'number'
            ? Date.now() - speechStoppedAt
            : undefined;
        logger.info(
          {
            voiceSessionId,
            responseId: event.responseId,
            status: event.status,
            latencyFromSpeechStoppedMs: latencyMs,
          },
          'Realtime model response started',
        );
        this.lastSpeechStoppedAtMs.delete(voiceSessionId);
        break;
      }
      case 'audio.output': {
        const diagnostics = this.outputDiagnosticsBySession.get(
          voiceSessionId,
        ) ?? {
          chunkCount: 0,
          totalBytes: 0,
        };
        const now = Date.now();
        diagnostics.chunkCount += 1;
        diagnostics.totalBytes += event.pcm16.length;
        diagnostics.firstChunkAtMs ??= now;
        const gapSincePreviousAudioChunkMs =
          typeof diagnostics.lastChunkAtMs === 'number'
            ? now - diagnostics.lastChunkAtMs
            : undefined;
        diagnostics.lastChunkAtMs = now;
        this.outputDiagnosticsBySession.set(voiceSessionId, diagnostics);

        const sendStartedAtMs = Date.now();
        await active.adapter.sendAudio(
          active.record.platformSessionId,
          event.pcm16,
          event.sampleRate,
        );
        const adapterSendDurationMs = Date.now() - sendStartedAtMs;

        if (voiceStreamDiagnosticsEnabled) {
          logger.info(
            {
              voiceSessionId,
              platform: active.record.platform,
              platformSessionId: active.record.platformSessionId,
              audioChunkIndex: diagnostics.chunkCount,
              pcmBytes: event.pcm16.length,
              sampleRate: event.sampleRate,
              estimatedDurationMs: estimatePcmDurationMs(
                event.pcm16.length,
                event.sampleRate,
              ),
              gapSincePreviousAudioChunkMs,
              latencyFromResponseStartedMs:
                typeof diagnostics.responseStartedAtMs === 'number' &&
                diagnostics.chunkCount === 1
                  ? now - diagnostics.responseStartedAtMs
                  : undefined,
              adapterSendDurationMs,
            },
            'Forwarded realtime audio chunk to voice adapter',
          );
        }
        break;
      }
      case 'transcript.final':
        logger.debug(
          { voiceSessionId, role: event.role, length: event.text.length },
          'Persisting realtime transcript entry',
        );
        appendVoiceTranscript({
          voiceSessionId,
          role: event.role,
          content: event.text,
          createdAt: new Date().toISOString(),
        });
        break;
      case 'tool.call': {
        logger.info(
          {
            voiceSessionId,
            toolName: event.toolName,
            callId: event.callId,
          },
          'Executing realtime tool call',
        );
        try {
          const result = await toolBridge.execute(
            event.toolName,
            event.arguments,
          );
          await active.realtime.sendToolResult(event.callId, result);
        } catch (err) {
          logger.error(
            {
              err,
              voiceSessionId,
              toolName: event.toolName,
              callId: event.callId,
            },
            'Realtime tool call failed',
          );
          await active.realtime.sendToolResult(event.callId, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
      case 'response.finished':
        this.activeResponseBySession.set(voiceSessionId, false);
        const diagnostics = this.outputDiagnosticsBySession.get(voiceSessionId);
        logger.info(
          {
            voiceSessionId,
            responseId: event.responseId,
            status: event.status,
            outputChunkCount: diagnostics?.chunkCount,
            outputAudioBytes: diagnostics?.totalBytes,
            outputAudioDurationMs:
              typeof diagnostics?.totalBytes === 'number'
                ? estimatePcmDurationMs(diagnostics.totalBytes, 24000)
                : undefined,
            timeToFirstOutputChunkMs:
              diagnostics?.responseStartedAtMs && diagnostics.firstChunkAtMs
                ? diagnostics.firstChunkAtMs - diagnostics.responseStartedAtMs
                : undefined,
          },
          'Realtime model response finished',
        );
        this.outputDiagnosticsBySession.delete(voiceSessionId);
        break;
      case 'response.interrupted':
        logger.info(
          {
            voiceSessionId,
            outputChunkCount:
              this.outputDiagnosticsBySession.get(voiceSessionId)?.chunkCount,
            outputAudioBytes:
              this.outputDiagnosticsBySession.get(voiceSessionId)?.totalBytes,
          },
          'Realtime model response interrupted',
        );
        this.activeResponseBySession.set(voiceSessionId, false);
        this.outputDiagnosticsBySession.delete(voiceSessionId);
        break;
      case 'session.error':
        logger.error(
          { voiceSessionId, error: event.error },
          'Realtime voice session failed',
        );
        markVoiceSessionEnded(voiceSessionId, 'failed');
        this.clearSessionSpeechState(voiceSessionId);
        this.lastSpeechStoppedAtMs.delete(voiceSessionId);
        this.activeResponseBySession.delete(voiceSessionId);
        this.activeSessions.delete(voiceSessionId);
        this.outputDiagnosticsBySession.delete(voiceSessionId);
        break;
      case 'session.closed':
        logger.info({ voiceSessionId }, 'Realtime voice session closed');
        markVoiceSessionEnded(voiceSessionId, 'ended');
        this.clearSessionSpeechState(voiceSessionId);
        this.lastSpeechStoppedAtMs.delete(voiceSessionId);
        this.activeResponseBySession.delete(voiceSessionId);
        this.outputDiagnosticsBySession.delete(voiceSessionId);
        this.activeSessions.delete(voiceSessionId);
        break;
      default:
        break;
    }
  }

  private scheduleSpeechInterrupt(
    voiceSessionId: string,
    participantId: string,
  ): void {
    this.clearPendingSpeechInterrupt(voiceSessionId, participantId);
    const key = this.speechInterruptKey(voiceSessionId, participantId);
    const timer = setTimeout(() => {
      void this.runSpeechInterrupt(voiceSessionId, participantId);
    }, VoiceBridgeSessionManager.SPEECH_INTERRUPT_DEBOUNCE_MS);
    timer.unref?.();
    this.pendingSpeechInterrupts.set(key, timer);
  }

  private clearPendingSpeechInterrupt(
    voiceSessionId: string,
    participantId: string,
  ): void {
    const key = this.speechInterruptKey(voiceSessionId, participantId);
    const timer = this.pendingSpeechInterrupts.get(key);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.pendingSpeechInterrupts.delete(key);
  }

  private clearSessionSpeechState(voiceSessionId: string): void {
    for (const [key, timer] of this.pendingSpeechInterrupts.entries()) {
      if (!key.startsWith(`${voiceSessionId}:`)) {
        continue;
      }
      clearTimeout(timer);
      this.pendingSpeechInterrupts.delete(key);
    }
  }

  private async runSpeechInterrupt(
    voiceSessionId: string,
    participantId: string,
  ): Promise<void> {
    const key = this.speechInterruptKey(voiceSessionId, participantId);
    this.pendingSpeechInterrupts.delete(key);

    const active = this.activeSessions.get(voiceSessionId);
    if (!active) {
      return;
    }

    logger.debug(
      { voiceSessionId, participantId },
      'Interrupting assistant output after debounced speech start',
    );
    await active.adapter.interruptOutput(active.record.platformSessionId);

    if (!this.activeResponseBySession.get(voiceSessionId)) {
      logger.debug(
        { voiceSessionId, participantId },
        'Skipping realtime cancel; no active model response',
      );
      return;
    }

    await active.realtime.interrupt();
  }

  private speechInterruptKey(
    voiceSessionId: string,
    participantId: string,
  ): string {
    return `${voiceSessionId}:${participantId}`;
  }

  private async getAgentOrThrow(routeKey: string): Promise<Agent> {
    const agent = await resolveVoiceAgent(routeKey);
    if (!agent) {
      logger.error({ routeKey }, 'No agent resolved for voice route');
      throw new Error(`No agent configured for voice route ${routeKey}`);
    }
    logger.debug({ routeKey, agentId: agent.id }, 'Resolved voice agent');
    return agent;
  }
}
