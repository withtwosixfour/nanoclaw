import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalCwd = process.cwd();

describe('voice prompt loader', () => {
  afterEach(() => {
    process.chdir(originalCwd);
    vi.resetModules();
  });

  it('builds prompt with agent, global, and voice guidance', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-prompt-'));
    fs.mkdirSync(path.join(tempDir, 'agents', 'main'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'agents', 'global'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'agents', 'main', 'CLAUDE.md'),
      'Agent prompt',
    );
    fs.writeFileSync(
      path.join(tempDir, 'agents', 'global', 'CLAUDE.md'),
      'Global prompt',
    );
    process.chdir(tempDir);

    const { buildVoiceSystemPrompt } = await import('./prompt-loader.js');
    const prompt = buildVoiceSystemPrompt({
      agentId: 'main',
      isMain: false,
      routeKey: 'voice:discord:dm:user-1',
    });

    expect(prompt).toContain('Agent prompt');
    expect(prompt).toContain('Global prompt');
    expect(prompt).toContain('live voice conversation');
    expect(prompt).toContain('voice:discord:dm:user-1');
  });
});
