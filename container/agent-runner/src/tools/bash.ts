import { exec } from 'child_process';
import { promisify } from 'util';
import { z } from 'zod';
import { tool } from 'ai';

const execAsync = promisify(exec);

const SECRET_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENCODE_ZEN_API_KEY',
];

function buildSanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SECRET_ENV_VARS) {
    delete env[key];
  }
  return env;
}

export function createBashTool() {
  return tool({
    description: 'Run a shell command inside the group workspace.',
    parameters: z.object({
      command: z.string().describe('Command to execute'),
      workdir: z
        .string()
        .optional()
        .describe('Working directory (defaults to /workspace/group)'),
      timeout: z.number().int().optional().describe('Timeout in milliseconds'),
    }),
    execute: async (input: {
      command: string;
      workdir?: string;
      timeout?: number;
    }) => {
      const { command, workdir, timeout } = input;
      const cwd = workdir || '/workspace/group';
      const env = buildSanitizedEnv();
      const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
      const finalCommand = unsetPrefix + command;

      try {
        const { stdout, stderr } = await execAsync(finalCommand, {
          cwd,
          env,
          timeout: timeout ?? 120000,
          maxBuffer: 10 * 1024 * 1024,
          shell: '/bin/bash',
        });
        return { stdout, stderr, exitCode: 0 };
      } catch (err) {
        const error = err as {
          stdout?: string;
          stderr?: string;
          code?: number;
          message?: string;
        };
        return {
          stdout: error.stdout ?? '',
          stderr: error.stderr ?? error.message ?? 'Command failed',
          exitCode: error.code ?? 1,
        };
      }
    },
  });
}
