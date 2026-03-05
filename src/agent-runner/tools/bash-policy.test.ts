import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  evaluateBashCommandPolicy,
  loadBashPolicy,
  parseCommandSegments,
} from './bash-policy.js';

const tempDirs: string[] = [];

function makeAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-policy-test-'));
  tempDirs.push(dir);
  return dir;
}

function writePolicy(agentDir: string, policy: unknown): void {
  const policyPath = path.join(agentDir, '.nanoclaw', 'bash-policy.json');
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, JSON.stringify(policy, null, 2), 'utf-8');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('bash-policy parseCommandSegments', () => {
  it('parses chained commands and keeps args', () => {
    const segments = parseCommandSegments(
      'FOO=bar git status && env A=1 npm run test; ls -la | wc -l',
    );

    expect(segments.map((s) => s.command)).toEqual(['git', 'npm', 'ls', 'wc']);
    expect(segments[0]?.args).toEqual(['status']);
    expect(segments[1]?.args).toEqual(['run', 'test']);
  });
});

describe('bash-policy load and evaluate', () => {
  it('allows all when no policy file exists', () => {
    const agentDir = makeAgentDir();
    const result = loadBashPolicy(agentDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.found).toBe(false);
    }
  });

  it('denies blacklisted command in a chain', () => {
    const agentDir = makeAgentDir();
    writePolicy(agentDir, {
      mode: 'blacklist',
      commands: { blacklist: ['rm'] },
    });

    const load = loadBashPolicy(agentDir);
    expect(load.ok).toBe(true);
    expect(load.ok && load.found).toBe(true);
    if (!load.ok || !load.found) return;

    const decision = evaluateBashCommandPolicy(
      load.policy,
      'git status && rm -rf ./tmp',
    );

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain('blacklisted');
      expect(decision.reason).toContain('rm');
    }
  });

  it('denies command not in whitelist', () => {
    const agentDir = makeAgentDir();
    writePolicy(agentDir, {
      mode: 'whitelist',
      commands: { whitelist: ['git'] },
    });

    const load = loadBashPolicy(agentDir);
    if (!load.ok || !load.found) {
      throw new Error('Expected policy to load');
    }

    const decision = evaluateBashCommandPolicy(
      load.policy,
      'git status && npm -v',
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain('not in whitelist');
      expect(decision.reason).toContain('npm');
    }
  });

  it('denies specific flags and patterns', () => {
    const agentDir = makeAgentDir();
    writePolicy(agentDir, {
      mode: 'whitelist',
      commands: { whitelist: ['git'] },
      args: {
        git: {
          denyFlags: ['--force', '--no-verify'],
          denyPatterns: ['--force-with-lease'],
        },
      },
    });

    const load = loadBashPolicy(agentDir);
    if (!load.ok || !load.found) {
      throw new Error('Expected policy to load');
    }

    const byFlag = evaluateBashCommandPolicy(
      load.policy,
      'git push --force origin main',
    );
    expect(byFlag.allowed).toBe(false);

    const byPattern = evaluateBashCommandPolicy(
      load.policy,
      'git push origin main --force-with-lease',
    );
    expect(byPattern.allowed).toBe(false);
  });

  it('rejects invalid policy schema', () => {
    const agentDir = makeAgentDir();
    writePolicy(agentDir, {
      mode: 'whitelist',
      commands: { whitelist: ['git'] },
      unknownKey: true,
    });

    const load = loadBashPolicy(agentDir);
    expect(load.ok).toBe(false);
  });

  it('denies denied operators when configured', () => {
    const agentDir = makeAgentDir();
    writePolicy(agentDir, {
      mode: 'whitelist',
      commands: { whitelist: ['git'] },
      shell: { denyOperators: ['&&'] },
    });

    const load = loadBashPolicy(agentDir);
    if (!load.ok || !load.found) {
      throw new Error('Expected policy to load');
    }

    const decision = evaluateBashCommandPolicy(
      load.policy,
      'git status && git branch',
    );
    expect(decision.allowed).toBe(false);
  });
});
