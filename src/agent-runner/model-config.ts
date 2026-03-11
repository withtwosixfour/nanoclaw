export interface ModelConfig {
  provider: string;
  modelName: string;
  contextWindow: number;
  compactionThresholdPercent: number;
  supportsVision: boolean;
  isOpenAIResponseFormat?: boolean;
}

export interface AvailableModel {
  provider: string;
  modelName: string;
  contextWindow: number;
  supportsVision: boolean;
}

interface OpenRouterModelArchitecture {
  input_modalities?: string[] | null;
}

interface OpenRouterTopProvider {
  context_length?: number | null;
}

interface OpenRouterModel {
  id: string;
  context_length?: number | null;
  architecture?: OpenRouterModelArchitecture | null;
  top_provider?: OpenRouterTopProvider | null;
  supported_parameters?: string[] | null;
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModel[];
}

const OPENROUTER_PROVIDER = 'openrouter';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_CACHE_TTL_MS = 5 * 60 * 1000;
const OPENROUTER_FETCH_TIMEOUT_MS = 10 * 1000;
const OPENROUTER_DEFAULT_CONTEXT_WINDOW = 128000;

const DEFAULT_MODEL_CONFIG: ModelConfig = {
  provider: 'opencode-zen',
  modelName: 'kimi-k2.5',
  contextWindow: 200000,
  compactionThresholdPercent: 60,
  supportsVision: true,
};

const STATIC_MODEL_CONFIGS: Record<string, ModelConfig> = {
  'opencode-zen:kimi-k2.5': {
    ...DEFAULT_MODEL_CONFIG,
  },
  'opencode-zen:gpt-5.3-codex': {
    provider: 'opencode-zen',
    modelName: 'gpt-5.3-codex',
    isOpenAIResponseFormat: true,
    contextWindow: 400000,
    compactionThresholdPercent: 60,
    supportsVision: true,
  },
  'opencode-zen:gpt-5.4': {
    provider: 'opencode-zen',
    modelName: 'gpt-5.4',
    isOpenAIResponseFormat: true,
    contextWindow: 400000,
    compactionThresholdPercent: 60,
    supportsVision: true,
  },
};

type OpenRouterCatalogCache = {
  fetchedAt: number;
  models: Record<string, ModelConfig>;
};

let openRouterCatalogCache: OpenRouterCatalogCache | null = null;
let openRouterCatalogPromise: Promise<Record<string, ModelConfig>> | null =
  null;

function hasOpenRouterApiKey(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

function cloneModelConfig(config: ModelConfig): ModelConfig {
  return { ...config };
}

function toAvailableModel(config: ModelConfig): AvailableModel {
  return {
    provider: config.provider,
    modelName: config.modelName,
    contextWindow: config.contextWindow,
    supportsVision: config.supportsVision,
  };
}

function getStaticModelConfigs(): Record<string, ModelConfig> {
  return STATIC_MODEL_CONFIGS;
}

export function getStaticAvailableModels(): AvailableModel[] {
  return Object.values(getStaticModelConfigs())
    .map((config) => toAvailableModel(config))
    .sort((a, b) =>
      `${a.provider}:${a.modelName}`.localeCompare(
        `${b.provider}:${b.modelName}`,
      ),
    );
}

export function listStaticModelKeys(): string[] {
  return Object.keys(getStaticModelConfigs()).sort();
}

function getOpenRouterHeaders(): Record<string, string> | undefined {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return undefined;
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

function normalizeContextWindow(model: OpenRouterModel): number {
  const candidates = [model.context_length, model.top_provider?.context_length];
  for (const candidate of candidates) {
    if (
      typeof candidate === 'number' &&
      Number.isFinite(candidate) &&
      candidate > 0
    ) {
      return Math.floor(candidate);
    }
  }
  return OPENROUTER_DEFAULT_CONTEXT_WINDOW;
}

function supportsToolUse(model: OpenRouterModel): boolean {
  return Array.isArray(model.supported_parameters)
    ? model.supported_parameters.includes('tools')
    : false;
}

function supportsVision(model: OpenRouterModel): boolean {
  return Array.isArray(model.architecture?.input_modalities)
    ? model.architecture.input_modalities.includes('image')
    : false;
}

function normalizeOpenRouterModel(model: OpenRouterModel): ModelConfig | null {
  if (!model.id || !supportsToolUse(model)) {
    return null;
  }

  return {
    provider: OPENROUTER_PROVIDER,
    modelName: model.id,
    contextWindow: normalizeContextWindow(model),
    compactionThresholdPercent: 60,
    supportsVision: supportsVision(model),
    isOpenAIResponseFormat: false,
  };
}

async function fetchOpenRouterCatalog(): Promise<Record<string, ModelConfig>> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    OPENROUTER_FETCH_TIMEOUT_MS,
  );

  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      headers: getOpenRouterHeaders(),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const suffix = body ? ` ${body.slice(0, 500)}` : '';
      throw new Error(
        `OpenRouter models request failed with ${response.status}.${suffix}`.trim(),
      );
    }

    const payload = (await response.json()) as OpenRouterModelsResponse;
    if (!Array.isArray(payload.data)) {
      throw new Error(
        'OpenRouter models response did not include a data array.',
      );
    }

    const configs: Record<string, ModelConfig> = {};
    for (const model of payload.data) {
      const config = normalizeOpenRouterModel(model);
      if (!config) continue;
      configs[`${config.provider}:${config.modelName}`] = config;
    }

    openRouterCatalogCache = {
      fetchedAt: Date.now(),
      models: configs,
    };

    return configs;
  } catch (error) {
    if (openRouterCatalogCache) {
      openRouterCatalogCache = {
        ...openRouterCatalogCache,
        fetchedAt: Date.now(),
      };
      return openRouterCatalogCache.models;
    }

    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Unable to load OpenRouter models: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function getOpenRouterCatalog(): Promise<Record<string, ModelConfig>> {
  if (!hasOpenRouterApiKey()) {
    return openRouterCatalogCache?.models ?? {};
  }

  if (
    openRouterCatalogCache &&
    Date.now() - openRouterCatalogCache.fetchedAt < OPENROUTER_CACHE_TTL_MS
  ) {
    return openRouterCatalogCache.models;
  }

  if (!openRouterCatalogPromise) {
    openRouterCatalogPromise = fetchOpenRouterCatalog().finally(() => {
      openRouterCatalogPromise = null;
    });
  }

  return openRouterCatalogPromise;
}

async function getAllModelConfigs(): Promise<Record<string, ModelConfig>> {
  const configs: Record<string, ModelConfig> = {
    ...getStaticModelConfigs(),
  };

  if (!hasOpenRouterApiKey() && !openRouterCatalogCache) {
    return configs;
  }

  const openRouterModels = await getOpenRouterCatalog();
  return {
    ...configs,
    ...openRouterModels,
  };
}

export async function getAvailableModels(): Promise<AvailableModel[]> {
  const configs = await getAllModelConfigs();
  return Object.values(configs)
    .map((config) => toAvailableModel(config))
    .sort((a, b) =>
      `${a.provider}:${a.modelName}`.localeCompare(
        `${b.provider}:${b.modelName}`,
      ),
    );
}

export async function listAvailableModelKeys(): Promise<string[]> {
  const configs = await getAllModelConfigs();
  return Object.keys(configs).sort();
}

export async function isModelConfigured(
  provider: string,
  modelName: string,
): Promise<boolean> {
  if (provider === OPENROUTER_PROVIDER) {
    const configs = await getOpenRouterCatalog();
    return `${provider}:${modelName}` in configs;
  }

  return `${provider}:${modelName}` in getStaticModelConfigs();
}

export async function getModelConfig(
  provider?: string,
  modelName?: string,
): Promise<ModelConfig> {
  if (!provider || !modelName) return cloneModelConfig(DEFAULT_MODEL_CONFIG);

  if (provider === OPENROUTER_PROVIDER) {
    const configs = await getOpenRouterCatalog();
    const config = configs[`${provider}:${modelName}`];
    return config
      ? cloneModelConfig(config)
      : cloneModelConfig(DEFAULT_MODEL_CONFIG);
  }

  const config = getStaticModelConfigs()[`${provider}:${modelName}`];
  return config
    ? cloneModelConfig(config)
    : cloneModelConfig(DEFAULT_MODEL_CONFIG);
}

export function getCompactionThreshold(config: ModelConfig): number {
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

export function resetModelCatalogCache(): void {
  openRouterCatalogCache = null;
  openRouterCatalogPromise = null;
}
