import { exec } from 'child_process';
import { promisify } from 'util';
import { z } from 'zod';
import { tool } from 'ai';

import { resolveWorkspacePath, WorkspaceContext } from '../workspace-paths.js';
import { evaluateBashCommandPolicy, loadBashPolicy } from './bash-policy.js';
import { logger } from '../../logger.js';

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

export function createBashTool(ctx: WorkspaceContext) {
  return tool({
    description: 'Run a shell command inside the group workspace.',
    inputSchema: z.object({
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

      const policyResult = await loadBashPolicy(ctx.agentDir);
      if (!policyResult.ok) {
        return { stdout: '', stderr: policyResult.error, exitCode: 1 };
      }

      if (policyResult.found) {
        const decision = evaluateBashCommandPolicy(
          policyResult.policy,
          command,
        );

        // Audit logging
        if (!decision.allowed && policyResult.policy.logDenied) {
          logger.info(
            { agentDir: ctx.agentDir, command, reason: decision.reason },
            'Bash command denied by policy',
          );
        } else if (decision.allowed && policyResult.policy.logAllowed) {
          logger.info(
            { agentDir: ctx.agentDir, command },
            'Bash command allowed by policy',
          );
        }

        if (!decision.allowed) {
          return { stdout: '', stderr: decision.reason, exitCode: 1 };
        }
      }

      const resolved = resolveWorkspacePath(
        workdir || '/workspace/group',
        ctx,
        {
          allowProject: ctx.isMain,
          allowGlobal: !ctx.isMain,
          defaultCwd: ctx.agentDir,
        },
      );

      if (!resolved.resolvedPath) {
        return { stdout: '', stderr: resolved.error, exitCode: 1 };
      }

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: resolved.resolvedPath,
          env: buildSanitizedEnv(),
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
