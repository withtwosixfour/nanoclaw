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
  it('allows all when no policy file exists', async () => {
    const agentDir = makeAgentDir();
    const result = await loadBashPolicy(agentDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.found).toBe(false);
    }
  });

  it('denies blacklisted command in a chain', async () => {
    const agentDir = makeAgentDir();
    writePolicy(agentDir, {
      mode: 'blacklist',
      commands: { blacklist: ['rm'] },
    });

    const load = await loadBashPolicy(agentDir);
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

  it('denies command not in whitelist', async () => {
    const agentDir = makeAgentDir();
    writePolicy(agentDir, {
      mode: 'whitelist',
      commands: { whitelist: ['git'] },
    });

    const load = await loadBashPolicy(agentDir);
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

  it('denies specific flags and patterns', async () => {
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

    const load = await loadBashPolicy(agentDir);
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

  it('rejects invalid policy schema', async () => {
    const agentDir = makeAgentDir();
    writePolicy(agentDir, {
      mode: 'whitelist',
      commands: { whitelist: ['git'] },
      unknownKey: true,
    });

    const load = await loadBashPolicy(agentDir);
    expect(load.ok).toBe(false);
  });

  it('rejects whitelist mode without commands.whitelist entries', async () => {
    const agentDir = makeAgentDir();
    writePolicy(agentDir, {
      mode: 'whitelist',
      commands: {},
    });

    const load = await loadBashPolicy(agentDir);
    expect(load.ok).toBe(false);
    if (!load.ok) {
      expect(load.error).toContain('commands.whitelist');
    }
  });

  it('rejects blacklist mode without commands.blacklist entries', async () => {
    const agentDir = makeAgentDir();
    writePolicy(agentDir, {
      mode: 'blacklist',
      commands: {},
    });

    const load = await loadBashPolicy(agentDir);
    expect(load.ok).toBe(false);
    if (!load.ok) {
      expect(load.error).toContain('commands.blacklist');
    }
  });

  it('allows || when only | is denied', async () => {
    const agentDir = makeAgentDir();
    writePolicy(agentDir, {
      mode: 'whitelist',
      commands: { whitelist: ['git', 'npm'] },
      shell: { denyOperators: ['|'] },
    });

    const load = await loadBashPolicy(agentDir);
    if (!load.ok || !load.found) {
      throw new Error('Expected policy to load');
    }

    // || should be allowed when only | is denied
    const decision = evaluateBashCommandPolicy(
      load.policy,
      'git status || npm -v',
    );
    expect(decision.allowed).toBe(true);

    // | should still be denied
    const pipeDecision = evaluateBashCommandPolicy(
      load.policy,
      'git status | cat',
    );
    expect(pipeDecision.allowed).toBe(false);
  });

  it('denies blacklisted command in bare subshell', async () => {
    const agentDir = makeAgentDir();
    writePolicy(agentDir, {
      mode: 'blacklist',
      commands: { blacklist: ['rm'] },
    });

    const load = await loadBashPolicy(agentDir);
    if (!load.ok || !load.found) {
      throw new Error('Expected policy to load');
    }

    const decision = evaluateBashCommandPolicy(load.policy, '(rm -rf /tmp)');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain('blacklisted');
      expect(decision.reason).toContain('rm');
    }
  });

  it('denies blacklisted command in backtick substitution', async () => {
    const agentDir = makeAgentDir();
    writePolicy(agentDir, {
      mode: 'blacklist',
      commands: { blacklist: ['rm'] },
    });

    const load = await loadBashPolicy(agentDir);
    if (!load.ok || !load.found) {
      throw new Error('Expected policy to load');
    }

    const decision = evaluateBashCommandPolicy(load.policy, '`rm -rf /tmp`');
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain('blacklisted');
      expect(decision.reason).toContain('rm');
    }
  });

  it('denies combined short flags that include a denied short flag', async () => {
    const agentDir = makeAgentDir();
    writePolicy(agentDir, {
      mode: 'whitelist',
      commands: { whitelist: ['rm'] },
      args: {
        rm: {
          denyFlags: ['-r'],
        },
      },
    });

    const load = await loadBashPolicy(agentDir);
    if (!load.ok || !load.found) {
      throw new Error('Expected policy to load');
    }

    expect(evaluateBashCommandPolicy(load.policy, 'rm -rf /tmp').allowed).toBe(
      false,
    );
  });

  it('allows combined short flags when each short flag is allowlisted', async () => {
    const agentDir = makeAgentDir();
    writePolicy(agentDir, {
      mode: 'whitelist',
      commands: { whitelist: ['ls'] },
      args: {
        ls: {
          allowFlags: ['-l', '-a'],
        },
      },
    });

    const load = await loadBashPolicy(agentDir);
    if (!load.ok || !load.found) {
      throw new Error('Expected policy to load');
    }

    expect(evaluateBashCommandPolicy(load.policy, 'ls -la').allowed).toBe(true);
  });

  it('denies combined short flags when any short flag is not allowlisted', async () => {
    const agentDir = makeAgentDir();
    writePolicy(agentDir, {
      mode: 'whitelist',
      commands: { whitelist: ['rm'] },
      args: {
        rm: {
          allowFlags: ['-r'],
        },
      },
    });

    const load = await loadBashPolicy(agentDir);
    if (!load.ok || !load.found) {
      throw new Error('Expected policy to load');
    }

    expect(evaluateBashCommandPolicy(load.policy, 'rm -rf /tmp').allowed).toBe(
      false,
    );
  });

  it('parses bare subshell and backtick correctly', () => {
    // Test that parsing works correctly for subshells
    const subshellSegments = parseCommandSegments('(rm -rf /tmp)');
    expect(subshellSegments.length).toBe(1);
    expect(subshellSegments[0]?.command).toBe('rm');

    // Test that parsing works correctly for backticks
    const backtickSegments = parseCommandSegments('`rm -rf /tmp`');
    expect(backtickSegments.length).toBe(1);
    expect(backtickSegments[0]?.command).toBe('rm');
  });

  it('parses nested subshells and command substitutions correctly', () => {
    expect(parseCommandSegments('( (rm -rf /tmp) )')[0]?.command).toBe('rm');
    expect(
      parseCommandSegments('echo $(rm -rf /tmp)').map((s) => s.command),
    ).toEqual(['rm', 'echo']);
  });

  it('ignores denied operators inside quoted strings', async () => {
    const agentDir = makeAgentDir();
    writePolicy(agentDir, {
      mode: 'whitelist',
      commands: { whitelist: ['echo'] },
      shell: { denyOperators: [';', '|', '&'] },
    });

    const load = await loadBashPolicy(agentDir);
    if (!load.ok || !load.found) {
      throw new Error('Expected policy to load');
    }

    expect(
      evaluateBashCommandPolicy(
        load.policy,
        'echo "done; still | quoted & safe"',
      ).allowed,
    ).toBe(true);
  });

  it('rejects unsafe regex deny patterns', async () => {
    const agentDir = makeAgentDir();
    writePolicy(agentDir, {
      mode: 'whitelist',
      commands: { whitelist: ['git'] },
      args: {
        git: {
          denyPatterns: ['(a+)+'],
        },
      },
    });

    const load = await loadBashPolicy(agentDir);
    expect(load.ok).toBe(false);
    if (!load.ok) {
      expect(load.error).toContain('Unsafe deny pattern');
    }
  });

  it('rejects unsafe nested quantified regex deny patterns', async () => {
    const agentDir = makeAgentDir();
    writePolicy(agentDir, {
      mode: 'whitelist',
      commands: { whitelist: ['git'] },
      args: {
        git: {
          denyPatterns: ['((a+))+'],
        },
      },
    });

    const load = await loadBashPolicy(agentDir);
    expect(load.ok).toBe(false);
    if (!load.ok) {
      expect(load.error).toContain('Unsafe deny pattern');
    }
  });

  it('includes audit config in compiled policy', async () => {
    const agentDir = makeAgentDir();
    writePolicy(agentDir, {
      mode: 'whitelist',
      commands: { whitelist: ['git'] },
      audit: { logAllowed: true, logDenied: true },
    });

    const load = await loadBashPolicy(agentDir);
    if (!load.ok || !load.found) {
      throw new Error('Expected policy to load');
    }

    expect(load.policy.logAllowed).toBe(true);
    expect(load.policy.logDenied).toBe(true);
  });
});
