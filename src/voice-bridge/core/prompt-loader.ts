import { buildAgentSystemPrompt } from '../../agent-runner/prompt-loader.js';

const DEFAULT_VOICE_GUIDANCE = [
  'You are in a live voice conversation.',
  'Respond conversationally and briefly unless the user asks for more detail.',
  'Your only tools are delegate_to_agent and leave_call.',
  'Use delegate_to_agent for any deeper work so smarter background models can handle it while you stay focused on the conversation.',
  'Use leave_call when the user asks you to leave or when the conversation is clearly finished and it is appropriate to exit.',
  'When delegated work returns, summarize it naturally instead of reading raw status text.',
  'If the user interrupts, stop cleanly and adapt to the latest turn.',
].join(' ');

export function buildVoiceSystemPrompt(input: {
  agentId: string;
  isMain: boolean;
  routeKey: string;
  extraInstructions?: string[];
}): string {
  const basePrompt = buildAgentSystemPrompt(input.agentId, input.isMain);
  const routeContext = `You are operating in the voice conversation "${input.routeKey}" with agent "${input.agentId}".`;
  const parts = [routeContext, basePrompt, DEFAULT_VOICE_GUIDANCE];

  if (input.extraInstructions?.length) {
    parts.push(input.extraInstructions.join('\n'));
  }

  return parts.filter(Boolean).join('\n\n');
}
