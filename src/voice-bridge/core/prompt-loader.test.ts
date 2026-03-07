import { describe, expect, it, vi } from 'vitest';

vi.mock('../../agent-runner/prompt-loader.js', () => ({
  buildAgentSystemPrompt: vi.fn(() => 'Agent prompt\n\nGlobal prompt'),
}));

import { buildVoiceSystemPrompt } from './prompt-loader.js';

describe('voice prompt loader', () => {
  it('builds prompt with agent, global, and voice guidance', () => {
    const prompt = buildVoiceSystemPrompt({
      agentId: 'main',
      isMain: false,
      routeKey: 'voice:discord:dm:user-1',
    });

    expect(prompt).toContain('Agent prompt');
    expect(prompt).toContain('Global prompt');
    expect(prompt).toContain('live voice conversation');
    expect(prompt).toContain('delegate_to_agent');
    expect(prompt).toContain('leave_call');
    expect(prompt).toContain('voice:discord:dm:user-1');
  });
});
