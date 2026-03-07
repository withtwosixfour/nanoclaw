import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAllRoutes } = vi.hoisted(() => ({
  getAllRoutes: vi.fn(),
}));

import { resolveAgentId } from './router.js';

vi.mock('./db.js', () => ({
  getAllRoutes,
}));

describe('resolveAgentId voice routing', () => {
  beforeEach(() => {
    getAllRoutes.mockReset();
  });

  it('matches wildcard voice routes without thread parsing support', async () => {
    getAllRoutes.mockResolvedValue({
      'voice:discord:*': 'main',
    });

    await expect(
      resolveAgentId('voice:discord:guild-1:channel-2'),
    ).resolves.toBe('main');
  });

  it('still supports existing short discord routes', async () => {
    getAllRoutes.mockResolvedValue({
      'discord:channel-2': 'ops',
    });

    await expect(resolveAgentId('discord:guild-1:channel-2')).resolves.toBe(
      'ops',
    );
  });
});
