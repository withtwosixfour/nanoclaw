import type { Agent } from '../types.js';
import type { AgentInput, AgentOutput } from '../agent-runner/runtime.js';

export type VoicePlatform = 'discord' | 'slack';

export type VoiceSessionMode = 'direct' | 'join';

export interface VoiceSessionLink {
  textThreadId?: string;
  textSessionId?: string;
}

export interface VoiceSessionRequest {
  platform: VoicePlatform;
  mode: VoiceSessionMode;
  targetId: string;
  routeKey: string;
  startedBy?: string;
  participants?: Array<{ participantId: string; displayName: string }>;
  link?: VoiceSessionLink;
  metadata?: Record<string, unknown>;
}

export interface VoiceSessionRecord {
  voiceSessionId: string;
  platform: VoicePlatform;
  platformSessionId: string;
  routeKey: string;
  agentId: string;
  effectivePrompt: string;
  status: 'active' | 'ended' | 'failed';
  startedBy?: string;
  startedAt: string;
  endedAt?: string;
  linkedTextThreadId?: string;
  linkedTextSessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface VoiceParticipantRecord {
  voiceSessionId: string;
  participantId: string;
  displayName: string;
  joinedAt: string;
  leftAt?: string;
}

export interface VoiceTranscriptEntry {
  voiceSessionId: string;
  participantId?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: string;
}

export type VoiceEvent =
  | { type: 'session.started'; sessionId: string; platform: VoicePlatform }
  | {
      type: 'participant.joined';
      sessionId: string;
      participantId: string;
      displayName: string;
    }
  | {
      type: 'participant.left';
      sessionId: string;
      participantId: string;
    }
  | {
      type: 'audio.input';
      sessionId: string;
      participantId: string;
      pcm16: Buffer;
      sampleRate: number;
    }
  | {
      type: 'speech.started';
      sessionId: string;
      participantId: string;
    }
  | {
      type: 'speech.stopped';
      sessionId: string;
      participantId: string;
    }
  | {
      type: 'transcript.final';
      sessionId: string;
      participantId?: string;
      role: 'user' | 'assistant';
      text: string;
    }
  | { type: 'session.ended'; sessionId: string; reason?: string };

export interface VoicePlatformAdapter {
  readonly platform: VoicePlatform;
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

export interface RealtimeToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RealtimeSessionConfig {
  sessionId: string;
  model: string;
  voice?: string;
  instructions: string;
  speed?: number;
  tools: RealtimeToolDefinition[];
}

export type RealtimeEvent =
  | { type: 'session.ready'; sessionId: string }
  | {
      type: 'response.started';
      sessionId: string;
      responseId?: string;
      status?: string;
    }
  | {
      type: 'audio.output';
      sessionId: string;
      pcm16: Buffer;
      sampleRate: number;
    }
  | {
      type: 'transcript.final';
      sessionId: string;
      role: 'user' | 'assistant';
      text: string;
    }
  | {
      type: 'tool.call';
      sessionId: string;
      callId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    }
  | {
      type: 'response.finished';
      sessionId: string;
      responseId?: string;
      status?: string;
    }
  | { type: 'response.interrupted'; sessionId: string }
  | { type: 'session.error'; sessionId: string; error: string }
  | { type: 'session.closed'; sessionId: string };

export interface RealtimeSession {
  connect(config: RealtimeSessionConfig): Promise<void>;
  appendInputAudio(pcm16: Buffer, sampleRate: number): Promise<void>;
  interrupt(): Promise<void>;
  sendToolResult(callId: string, result: unknown): Promise<void>;
  addMessage(
    role: 'system' | 'user' | 'assistant',
    text: string,
    options?: { triggerResponse?: boolean },
  ): Promise<void>;
  close(): Promise<void>;
  onEvent(handler: (event: RealtimeEvent) => void): void;
}

export interface RealtimeSessionFactory {
  create(sessionId: string): RealtimeSession;
}

export interface VoiceBridgeDependencies {
  sendMessage: (jid: string, text: string, sender?: string) => Promise<void>;
  schedulerDeps: {
    agents: () => Promise<Record<string, Agent>>;
    getSessions: () => Promise<Record<string, string>>;
    runAgent: (input: AgentInput) => Promise<AgentOutput>;
    sendMessage: (jid: string, text: string) => Promise<void>;
  };
}
