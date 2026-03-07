export interface VoicePolicyInput {
  isDirectSession: boolean;
  hasWakeWord: boolean;
  wasExplicitlyInvited: boolean;
}

export function shouldRespondToVoiceTurn(input: VoicePolicyInput): boolean {
  if (input.isDirectSession) {
    return true;
  }

  if (input.wasExplicitlyInvited) {
    return true;
  }

  return input.hasWakeWord;
}

export function shouldInterruptForUserSpeech(): boolean {
  return true;
}
