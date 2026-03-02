import fs from 'fs';
import path from 'path';
import fg from 'fast-glob';
import { z } from 'zod';
import { tool } from 'ai';

import { resolveWorkspacePath, WorkspaceContext } from '../workspace-paths.js';
import {
  isImageFile,
  getMimeTypeFromExtension,
} from '../../attachments/images.js';

function resolvePath(
  inputPath: string,
  ctx: WorkspaceContext,
  options: { allowGlobal?: boolean; allowProject?: boolean } = {},
): { resolvedPath?: string; error?: string } {
  return resolveWorkspacePath(inputPath, ctx, {
    allowProject: options.allowProject ?? ctx.isMain,
    allowGlobal: options.allowGlobal ?? !ctx.isMain,
    defaultCwd: ctx.agentDir,
  });
}

export function createFsTools(ctx: WorkspaceContext) {
  return {
    Read: tool({
      description:
        'Read a file or directory from disk. Use to read images and view them',
      inputSchema: z.object({
        path: z.string().describe('File or directory path'),
        offset: z.number().int().optional().describe('Line offset (1-indexed)'),
        limit: z.number().int().optional().describe('Max lines to return'),
      }),
      execute: async (input: {
        path: string;
        offset?: number;
        limit?: number;
      }) => {
        const resolved = resolvePath(input.path, ctx, {
          allowGlobal: !ctx.isMain,
          allowProject: ctx.isMain,
        });
        if (!resolved.resolvedPath) {
          return { error: resolved.error };
        }

        const stat = fs.statSync(resolved.resolvedPath);
        if (stat.isDirectory()) {
          const entries = fs.readdirSync(resolved.resolvedPath).map((entry) => {
            const full = path.join(resolved.resolvedPath as string, entry);
            return fs.statSync(full).isDirectory() ? `${entry}/` : entry;
          });
          return { entries };
        }

        // Check if this is an image file
        if (isImageFile(resolved.resolvedPath)) {
          const mimeType = getMimeTypeFromExtension(resolved.resolvedPath);
          return {
            base64: fs.readFileSync(resolved.resolvedPath, 'base64'),
            content: `[media attached: ${resolved.resolvedPath} (${mimeType})]`,
            totalLines: 1,
            offset: 1,
            isImage: true,
            mimeType,
            path: resolved.resolvedPath,
          };
        }

        const content = fs.readFileSync(resolved.resolvedPath, 'utf-8');

        const lines = content.split('\n');
        const offset = Math.max((input.offset || 1) - 1, 0);
        const limit = input.limit ?? lines.length;
        const slice = lines.slice(offset, offset + limit);
        return {
          content: slice.join('\n'),
          totalLines: lines.length,
          offset: offset + 1,
        };
      },
      toModelOutput: ({ input, output }) => {
        const { base64, ...content } = output;
        if (!base64) {
          return {
            type: 'content',
            value: [
              {
                type: 'text',
                text: JSON.stringify(content),
              },
            ],
          };
        }

        return {
          type: 'content',
          value: [
            {
              type: 'image-data',
              data: base64!,
              mediaType: content.mimeType ?? '',
            },
            {
              type: 'text',
              text: JSON.stringify(content),
            },
          ],
        };
      },
    }),
    Write: tool({
      description: 'Write a file to disk, creating directories as needed.',
      inputSchema: z.object({
        path: z.string().describe('File path'),
        content: z.string().describe('File contents'),
      }),
      execute: async (input: { path: string; content: string }) => {
        const resolved = resolvePath(input.path, ctx, {
          allowGlobal: false,
          allowProject: ctx.isMain,
        });
        if (!resolved.resolvedPath) {
          return { error: resolved.error };
        }
        fs.mkdirSync(path.dirname(resolved.resolvedPath), { recursive: true });
        fs.writeFileSync(resolved.resolvedPath, input.content);
        return { path: resolved.resolvedPath };
      },
    }),
    Edit: tool({
      description: 'Replace a text snippet in a file.',
      inputSchema: z.object({
        path: z.string().describe('File path'),
        oldText: z.string().describe('Text to replace'),
        newText: z.string().describe('Replacement text'),
      }),
      execute: async (input: {
        path: string;
        oldText: string;
        newText: string;
      }) => {
        const resolved = resolvePath(input.path, ctx, {
          allowGlobal: false,
          allowProject: ctx.isMain,
        });
        if (!resolved.resolvedPath) {
          return { error: resolved.error };
        }
        const content = fs.readFileSync(resolved.resolvedPath, 'utf-8');
        const idx = content.indexOf(input.oldText);
        if (idx === -1) {
          return { error: 'Old text not found' };
        }
        const updated =
          content.slice(0, idx) +
          input.newText +
          content.slice(idx + input.oldText.length);
        fs.writeFileSync(resolved.resolvedPath, updated);
        return { path: resolved.resolvedPath };
      },
    }),
    Glob: tool({
      description: 'List files matching a glob pattern.',
      inputSchema: z.object({
        pattern: z.string().describe('Glob pattern'),
        cwd: z.string().optional().describe('Working directory'),
      }),
      execute: async (input: { pattern: string; cwd?: string }) => {
        const resolved = resolvePath(input.cwd || '/workspace/group', ctx, {
          allowGlobal: !ctx.isMain,
          allowProject: ctx.isMain,
        });
        if (!resolved.resolvedPath) {
          return { error: resolved.error, matches: [] };
        }
        const matches = await fg(input.pattern, {
          cwd: resolved.resolvedPath,
          dot: true,
          onlyFiles: false,
        });
        return { matches };
      },
    }),
    Grep: tool({
      description: 'Search file contents using a regex pattern.',
      inputSchema: z.object({
        pattern: z.string().describe('Regex pattern'),
        path: z.string().optional().describe('Directory to search'),
        include: z.string().optional().describe('Optional glob filter'),
      }),
      execute: async (input: {
        pattern: string;
        path?: string;
        include?: string;
      }) => {
        const resolved = resolvePath(input.path || '/workspace/group', ctx, {
          allowGlobal: !ctx.isMain,
          allowProject: ctx.isMain,
        });
        if (!resolved.resolvedPath) {
          return { error: resolved.error, matches: [] };
        }
        const globPattern = input.include || '**/*';
        const files = await fg(globPattern, {
          cwd: resolved.resolvedPath,
          dot: true,
          onlyFiles: true,
        });
        const regex = new RegExp(input.pattern);
        const matches: Array<{ file: string; line: number; text: string }> = [];

        for (const file of files) {
          const fullPath = path.join(resolved.resolvedPath, file);
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          lines.forEach((line, index) => {
            if (regex.test(line)) {
              matches.push({ file, line: index + 1, text: line });
            }
          });
        }

        return { matches };
      },
    }),
  };
}
