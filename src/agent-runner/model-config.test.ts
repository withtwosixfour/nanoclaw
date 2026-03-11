import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getAvailableModels,
  getModelConfig,
  isModelConfigured,
  resetModelCatalogCache,
} from './model-config.js';

function mockFetchOnce(value: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => value,
      text: async () => JSON.stringify(value),
    }),
  );
}

describe('model-config', () => {
  beforeEach(() => {
    resetModelCatalogCache();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    resetModelCatalogCache();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
  });

  it('exposes gpt-5.4 as an available model', async () => {
    mockFetchOnce({ data: [] });

    expect(
      (await getAvailableModels()).find(
        (model) =>
          model.provider === 'opencode-zen' && model.modelName === 'gpt-5.4',
      ),
    ).toEqual({
      provider: 'opencode-zen',
      modelName: 'gpt-5.4',
      contextWindow: 400000,
      supportsVision: true,
    });
  });

  it('validates gpt-5.4 and preserves its response format config', async () => {
    expect(await isModelConfigured('opencode-zen', 'gpt-5.4')).toBe(true);
    expect(await getModelConfig('opencode-zen', 'gpt-5.4')).toMatchObject({
      provider: 'opencode-zen',
      modelName: 'gpt-5.4',
      isOpenAIResponseFormat: true,
      contextWindow: 400000,
      supportsVision: true,
    });
  });

  it('does not fetch OpenRouter models when no API key is configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const models = await getAvailableModels();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(models.some((model) => model.provider === 'opencode-zen')).toBe(
      true,
    );
  });

  it('discovers only tool-capable OpenRouter models', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';

    mockFetchOnce({
      data: [
        {
          id: 'anthropic/claude-sonnet-4',
          context_length: 200000,
          architecture: { input_modalities: ['text', 'image'] },
          supported_parameters: ['tools', 'temperature'],
        },
        {
          id: 'deepseek/deepseek-r1:free',
          context_length: 128000,
          architecture: { input_modalities: ['text'] },
          supported_parameters: ['temperature'],
        },
      ],
    });

    expect(
      await isModelConfigured('openrouter', 'anthropic/claude-sonnet-4'),
    ).toBe(true);
    expect(
      await isModelConfigured('openrouter', 'deepseek/deepseek-r1:free'),
    ).toBe(false);
    expect(
      await getModelConfig('openrouter', 'anthropic/claude-sonnet-4'),
    ).toMatchObject({
      provider: 'openrouter',
      modelName: 'anthropic/claude-sonnet-4',
      contextWindow: 200000,
      supportsVision: true,
      isOpenAIResponseFormat: false,
    });
  });

  it('falls back to cached OpenRouter models when refresh fails', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'openai/gpt-4.1-mini',
              context_length: 100000,
              architecture: { input_modalities: ['text'] },
              supported_parameters: ['tools'],
            },
          ],
        }),
        text: async () => '',
      })
      .mockRejectedValueOnce(new Error('network down'));

    vi.stubGlobal('fetch', fetchMock);

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(0);
    expect(await isModelConfigured('openrouter', 'openai/gpt-4.1-mini')).toBe(
      true,
    );

    nowSpy.mockReturnValueOnce(10 * 60 * 1000);
    nowSpy.mockReturnValueOnce(10 * 60 * 1000);
    expect(await isModelConfigured('openrouter', 'openai/gpt-4.1-mini')).toBe(
      true,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    nowSpy.mockReturnValueOnce(10 * 60 * 1000 + 1);
    expect(await isModelConfigured('openrouter', 'openai/gpt-4.1-mini')).toBe(
      true,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws when OpenRouter cannot be loaded without a cache', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')));

    await expect(
      isModelConfigured('openrouter', 'anthropic/claude-sonnet-4'),
    ).rejects.toThrow('Unable to load OpenRouter models');
  });

  it('falls back to the default model for unknown model selections', async () => {
    expect(
      await getModelConfig('opencode-zen', 'does-not-exist'),
    ).toMatchObject({
      provider: 'opencode-zen',
      modelName: 'kimi-k2.5',
      contextWindow: 200000,
      supportsVision: true,
    });
  });
});
