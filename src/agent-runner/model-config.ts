export interface ModelConfig {
  provider: string;
  modelName: string;
  contextWindow: number;
  compactionThresholdPercent: number;
  supportsVision: boolean;
  isOpenAIResponseFormat?: boolean;
}

const DEFAULT_MODEL_CONFIG: ModelConfig = {
  provider: 'google-vertex',
  modelName: 'claude-sonnet-4-6',
  contextWindow: 1000000,
  compactionThresholdPercent: 60,
  supportsVision: true,
};

const MODEL_CONFIGS: Record<string, ModelConfig> = {
  'google-vertex:claude-sonnet-4-6': {
    ...DEFAULT_MODEL_CONFIG,
  },
  'google-vertex:claude-opus-4-6': {
    provider: 'google-vertex',
    modelName: 'claude-opus-4-6',
    contextWindow: 1000000,
    compactionThresholdPercent: 60,
    supportsVision: true,
  },
  'google-vertex:gemini-3.1-pro-preview': {
    provider: 'google-vertex',
    modelName: 'gemini-3.1-pro-preview',
    contextWindow: 1048576,
    compactionThresholdPercent: 60,
    supportsVision: true,
  },
  'opencode-zen:kimi-k2.5': {
    provider: 'opencode-zen',
    modelName: 'kimi-k2.5',
    contextWindow: 200000,
    compactionThresholdPercent: 60,
    supportsVision: true,
  },
  'opencode-zen:gpt-5.3-codex': {
    provider: 'opencode-zen',
    modelName: 'gpt-5.3-codex',
    isOpenAIResponseFormat: true,
    contextWindow: 400000,
    compactionThresholdPercent: 60,
    supportsVision: true,
  },
};

export function getAvailableModels(): Array<{
  provider: string;
  modelName: string;
  contextWindow: number;
  supportsVision: boolean;
}> {
  return Object.values(MODEL_CONFIGS).map((config) => ({
    provider: config.provider,
    modelName: config.modelName,
    contextWindow: config.contextWindow,
    supportsVision: config.supportsVision,
  }));
}

export function listAvailableModelKeys(): string[] {
  return Object.keys(MODEL_CONFIGS).sort();
}

export function isModelConfigured(
  provider: string,
  modelName: string,
): boolean {
  return `${provider}:${modelName}` in MODEL_CONFIGS;
}

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
  // Without maxOutputTokens, use 80% of context window as threshold
  return Math.floor(
    (config.contextWindow * config.compactionThresholdPercent) / 100,
  );
}

export function getDefaultModel(): { provider: string; modelName: string } {
  return {
    provider: DEFAULT_MODEL_CONFIG.provider,
    modelName: DEFAULT_MODEL_CONFIG.modelName,
  };
}
