import { describe, expect, it } from 'vitest';

import {
  buildVoiceRouteKey,
  getVoiceRouteCandidates,
  isVoiceRouteKey,
} from './identity.js';

describe('voice route identity', () => {
  it('builds direct session keys', () => {
    expect(
      buildVoiceRouteKey({
        platform: 'discord',
        mode: 'direct',
        userId: 'user-1',
      }),
    ).toBe('voice:discord:dm:user-1');
  });

  it('builds joined session keys', () => {
    expect(
      buildVoiceRouteKey({
        platform: 'slack',
        mode: 'join',
        workspaceId: 'team-1',
        channelId: 'chan-1',
        channelSessionId: 'huddle-1',
      }),
    ).toBe('voice:slack:team-1:chan-1:huddle-1');
  });

  it('produces fallback candidates for joined sessions', () => {
    expect(
      getVoiceRouteCandidates('voice:slack:team-1:chan-1:huddle-1'),
    ).toContain('voice:slack:team-1:*');
  });

  it('detects voice route keys', () => {
    expect(isVoiceRouteKey('voice:discord:dm:user-1')).toBe(true);
    expect(isVoiceRouteKey('discord:guild:channel')).toBe(false);
  });
});
