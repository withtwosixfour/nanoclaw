export interface ModelConfig {
  provider: string;
  modelName: string;
  contextWindow: number;
  maxOutputTokens: number;
  compactionThresholdPercent: number;
}

const DEFAULT_MODEL_CONFIG: ModelConfig = {
  provider: 'opencode-zen',
  modelName: 'kimi-k2.5',
  contextWindow: 200000,
  maxOutputTokens: 8192,
  compactionThresholdPercent: 60,
};

const MODEL_CONFIGS: Record<string, ModelConfig> = {
  'opencode-zen:kimi-k2.5': {
    ...DEFAULT_MODEL_CONFIG,
  },
};

export function getModelConfig(
  provider?: string,
  modelName?: string,
): ModelConfig {
  if (!provider || !modelName) return { ...DEFAULT_MODEL_CONFIG };
  const key = `${provider}:${modelName}`;
  const config = MODEL_CONFIGS[key];
  return config ? { ...config } : { ...DEFAULT_MODEL_CONFIG };
}

export function getCompactionThreshold(config: ModelConfig): number {
  const usable = Math.max(0, config.contextWindow - config.maxOutputTokens);
  return Math.floor((usable * config.compactionThresholdPercent) / 100);
}

export function getDefaultModel(): { provider: string; modelName: string } {
  return {
    provider: DEFAULT_MODEL_CONFIG.provider,
    modelName: DEFAULT_MODEL_CONFIG.modelName,
  };
}
