import { logger } from '../logger.js';
import type { VoiceBridgeDependencies, VoicePlatformAdapter } from './types.js';
import { VoiceBridgeSessionManager } from './core/session-manager.js';
import { OpenAIRealtimeSessionFactory } from './realtime/openai.js';

let voiceBridge: VoiceBridgeSessionManager | null = null;

export function createVoiceBridge(
  deps: VoiceBridgeDependencies,
  adapters: VoicePlatformAdapter[] = [],
): VoiceBridgeSessionManager {
  const bridge = new VoiceBridgeSessionManager(
    deps,
    new OpenAIRealtimeSessionFactory(),
  );
  for (const adapter of adapters) {
    bridge.registerAdapter(adapter);
  }
  return bridge;
}

export async function initializeVoiceBridge(
  deps: VoiceBridgeDependencies,
  adapters: VoicePlatformAdapter[] = [],
): Promise<VoiceBridgeSessionManager | null> {
  if (process.env.VOICE_BRIDGE_ENABLED !== 'true') {
    return null;
  }

  voiceBridge = createVoiceBridge(deps, adapters);
  await voiceBridge.connectAdapters();
  logger.info('Voice bridge initialized');
  return voiceBridge;
}

export function getVoiceBridge(): VoiceBridgeSessionManager | null {
  return voiceBridge;
}
