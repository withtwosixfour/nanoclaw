import fs from 'fs';
import path from 'path';

import { AGENTS_DIR } from '../config.js';
import { logger } from '../logger.js';

interface CachedPromptFile {
  content: string | null;
  mtime: number;
  watcher?: fs.FSWatcher;
}

const fileCache = new Map<string, CachedPromptFile>();

function attachWatcher(filePath: string): void {
  const cached = fileCache.get(filePath);
  if (cached?.watcher) {
    return;
  }

  try {
    const watcher = fs.watch(filePath, () => {
      const current = fileCache.get(filePath);
      fileCache.delete(filePath);
      current?.watcher?.close();
    });

    if (cached) {
      cached.watcher = watcher;
      return;
    }

    fileCache.set(filePath, {
      content: null,
      mtime: 0,
      watcher,
    });
  } catch (err) {
    logger.debug({ filePath, err }, 'Failed to watch prompt file');
  }
}

export function getCachedPromptFileContent(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    const cached = fileCache.get(filePath);
    cached?.watcher?.close();
    fileCache.delete(filePath);
    return null;
  }

  const stats = fs.statSync(filePath);
  const cached = fileCache.get(filePath);

  if (cached && cached.mtime === stats.mtimeMs) {
    return cached.content;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    fileCache.set(filePath, {
      content,
      mtime: stats.mtimeMs,
      watcher: cached?.watcher,
    });
    attachWatcher(filePath);
    return content;
  } catch (err) {
    logger.error({ filePath, err }, 'Failed to read prompt file');
    return null;
  }
}

export function buildAgentSystemPrompt(
  agentId: string,
  isMain: boolean,
): string {
  const agentPromptPath = path.join(AGENTS_DIR, agentId, 'CLAUDE.md');
  const globalPromptPath = path.join(AGENTS_DIR, 'global', 'CLAUDE.md');
  const parts: string[] = [];

  const agentContent = getCachedPromptFileContent(agentPromptPath);
  if (agentContent) {
    parts.push(agentContent.trim());
  }

  if (!isMain) {
    const globalContent = getCachedPromptFileContent(globalPromptPath);
    if (globalContent) {
      parts.push(globalContent.trim());
    }
  }

  return parts.filter(Boolean).join('\n\n');
}

export function clearPromptLoaderCacheForTests(): void {
  for (const cached of fileCache.values()) {
    cached.watcher?.close();
  }
  fileCache.clear();
}
