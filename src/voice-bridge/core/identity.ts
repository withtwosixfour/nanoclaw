import type { VoicePlatform, VoiceSessionMode } from '../types.js';

export function buildVoiceRouteKey(input: {
  platform: VoicePlatform;
  mode: VoiceSessionMode;
  workspaceId?: string;
  channelId?: string;
  channelSessionId?: string;
  userId?: string;
}): string {
  if (input.mode === 'direct') {
    if (!input.userId) {
      throw new Error('userId is required for direct voice routes');
    }
    return `voice:${input.platform}:dm:${input.userId}`;
  }

  if (!input.workspaceId || !input.channelId) {
    throw new Error('workspaceId and channelId are required for joined calls');
  }

  if (input.channelSessionId) {
    return `voice:${input.platform}:${input.workspaceId}:${input.channelId}:${input.channelSessionId}`;
  }

  return `voice:${input.platform}:${input.workspaceId}:${input.channelId}`;
}

export function getVoiceRouteCandidates(routeKey: string): string[] {
  const parts = routeKey.split(':');
  if (parts[0] !== 'voice' || parts.length < 3) {
    return [routeKey];
  }

  const candidates = new Set<string>([routeKey]);

  if (parts[2] === 'dm' && parts.length >= 4) {
    candidates.add(`voice:${parts[1]}:dm:*`);
    candidates.add(`voice:${parts[1]}:*`);
    candidates.add('voice:*');
    candidates.add('*');
    return Array.from(candidates);
  }

  if (parts.length >= 4) {
    candidates.add(`voice:${parts[1]}:${parts[2]}:${parts[3]}`);
    candidates.add(`voice:${parts[1]}:${parts[2]}:*`);
    candidates.add(`voice:${parts[1]}:*`);
    candidates.add('voice:*');
    candidates.add('*');
  }

  return Array.from(candidates);
}

export function isVoiceRouteKey(value: string): boolean {
  return value.startsWith('voice:');
}
