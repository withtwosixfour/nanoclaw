import fs from 'fs';
import path from 'path';
import fg from 'fast-glob';
import { z } from 'zod';
import { tool } from 'ai';

const DEFAULT_CWD = '/workspace/group';

function resolvePath(targetPath: string, cwd?: string): string {
  if (path.isAbsolute(targetPath)) return targetPath;
  return path.join(cwd || DEFAULT_CWD, targetPath);
}

export function createFsTools() {
  return {
    Read: tool({
      description: 'Read a file or directory from disk.',
      parameters: z.object({
        path: z.string().describe('File or directory path'),
        offset: z.number().int().optional().describe('Line offset (1-indexed)'),
        limit: z.number().int().optional().describe('Max lines to return'),
      }),
      execute: async (input: {
        path: string;
        offset?: number;
        limit?: number;
      }) => {
        const filePath = resolvePath(input.path);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          const entries = fs.readdirSync(filePath).map((entry) => {
            const full = path.join(filePath, entry);
            return fs.statSync(full).isDirectory() ? `${entry}/` : entry;
          });
          return { entries };
        }

        const content = fs.readFileSync(filePath, 'utf-8');
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
    }),
    Write: tool({
      description: 'Write a file to disk, creating directories as needed.',
      parameters: z.object({
        path: z.string().describe('File path'),
        content: z.string().describe('File contents'),
      }),
      execute: async (input: { path: string; content: string }) => {
        const filePath = resolvePath(input.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, input.content);
        return { path: filePath };
      },
    }),
    Edit: tool({
      description: 'Replace a text snippet in a file.',
      parameters: z.object({
        path: z.string().describe('File path'),
        oldText: z.string().describe('Text to replace'),
        newText: z.string().describe('Replacement text'),
      }),
      execute: async (input: {
        path: string;
        oldText: string;
        newText: string;
      }) => {
        const filePath = resolvePath(input.path);
        const content = fs.readFileSync(filePath, 'utf-8');
        const idx = content.indexOf(input.oldText);
        if (idx === -1) {
          return { error: 'Old text not found' };
        }
        const updated =
          content.slice(0, idx) +
          input.newText +
          content.slice(idx + input.oldText.length);
        fs.writeFileSync(filePath, updated);
        return { path: filePath };
      },
    }),
    Glob: tool({
      description: 'List files matching a glob pattern.',
      parameters: z.object({
        pattern: z.string().describe('Glob pattern'),
        cwd: z.string().optional().describe('Working directory'),
      }),
      execute: async (input: { pattern: string; cwd?: string }) => {
        const cwd = input.cwd || DEFAULT_CWD;
        const matches = await fg(input.pattern, {
          cwd,
          dot: true,
          onlyFiles: false,
        });
        return { matches };
      },
    }),
    Grep: tool({
      description: 'Search file contents using a regex pattern.',
      parameters: z.object({
        pattern: z.string().describe('Regex pattern'),
        path: z.string().optional().describe('Directory to search'),
        include: z.string().optional().describe('Optional glob filter'),
      }),
      execute: async (input: {
        pattern: string;
        path?: string;
        include?: string;
      }) => {
        const cwd = input.path ? resolvePath(input.path) : DEFAULT_CWD;
        const globPattern = input.include || '**/*';
        const files = await fg(globPattern, {
          cwd,
          dot: true,
          onlyFiles: true,
        });
        const regex = new RegExp(input.pattern);
        const matches: Array<{ file: string; line: number; text: string }> = [];

        for (const file of files) {
          const fullPath = path.join(cwd, file);
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
