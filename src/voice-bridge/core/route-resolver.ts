import { getAgent } from '../../db.js';
import { resolveAgentId } from '../../router.js';
import type { Agent } from '../../types.js';

export async function resolveVoiceAgent(
  routeKey: string,
): Promise<Agent | null> {
  const agentId = await resolveAgentId(routeKey);
  if (!agentId) {
    return null;
  }

  return (await getAgent(agentId)) ?? null;
}
