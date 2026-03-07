import { describe, expect, it } from 'vitest';

import {
  shouldInterruptForUserSpeech,
  shouldRespondToVoiceTurn,
} from './policy.js';

describe('voice policy', () => {
  it('always responds in direct sessions', () => {
    expect(
      shouldRespondToVoiceTurn({
        isDirectSession: true,
        hasWakeWord: false,
        wasExplicitlyInvited: false,
      }),
    ).toBe(true);
  });

  it('requires wake word or invite in shared sessions', () => {
    expect(
      shouldRespondToVoiceTurn({
        isDirectSession: false,
        hasWakeWord: false,
        wasExplicitlyInvited: false,
      }),
    ).toBe(false);
    expect(
      shouldRespondToVoiceTurn({
        isDirectSession: false,
        hasWakeWord: true,
        wasExplicitlyInvited: false,
      }),
    ).toBe(true);
  });

  it('interrupts on user speech', () => {
    expect(shouldInterruptForUserSpeech()).toBe(true);
  });
});
