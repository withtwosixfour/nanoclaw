/**
 * Tool output truncation system.
 * Limits tool outputs to prevent context window overflow.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../logger.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const TOOL_OUTPUT_DIR = path.join(DATA_DIR, 'tool-output');

// Default limits - 200-500 lines as per user requirements
export const DEFAULT_MAX_LINES = 500;
export const DEFAULT_MAX_BYTES = 100 * 1024; // 100KB
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface TruncateOptions {
  maxLines?: number;
  maxBytes?: number;
  direction?: 'head' | 'tail';
}

export interface TruncateResult {
  content: string;
  truncated: boolean;
  outputPath?: string;
  removedLines?: number;
  removedBytes?: number;
}

/**
 * Initialize the tool output directory.
 */
export function initTruncate(): void {
  if (!fs.existsSync(TOOL_OUTPUT_DIR)) {
    fs.mkdirSync(TOOL_OUTPUT_DIR, { recursive: true });
    logger.info({ dir: TOOL_OUTPUT_DIR }, 'Created tool output directory');
  }
}

/**
 * Truncate tool output if it exceeds limits.
 * Saves full output to disk and returns truncated version.
 */
export function truncateOutput(
  text: string,
  options: TruncateOptions = {},
): TruncateResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const direction = options.direction ?? 'head';

  const lines = text.split('\n');
  const totalBytes = Buffer.byteLength(text, 'utf-8');

  // Check if truncation needed
  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    logger.debug(
      { lines: lines.length, bytes: totalBytes },
      'Tool output within limits, no truncation needed',
    );
    return {
      content: text,
      truncated: false,
    };
  }

  logger.debug(
    {
      originalLines: lines.length,
      originalBytes: totalBytes,
      maxLines,
      maxBytes,
    },
    'Tool output exceeds limits, truncating',
  );

  // Ensure directory exists
  initTruncate();

  // Save full output to disk
  const outputId = `tool_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const outputPath = path.join(TOOL_OUTPUT_DIR, `${outputId}.txt`);

  try {
    fs.writeFileSync(outputPath, text, 'utf-8');
    logger.debug(
      { outputPath, size: totalBytes },
      'Saved full tool output to disk',
    );
  } catch (err) {
    logger.error({ err, outputPath }, 'Failed to save full tool output');
    // Continue with truncation even if save fails
  }

  // Truncate the content
  const out: string[] = [];
  let i = 0;
  let bytes = 0;
  let hitBytes = false;

  if (direction === 'head') {
    for (i = 0; i < lines.length && i < maxLines; i++) {
      const size = Buffer.byteLength(lines[i], 'utf-8') + (i > 0 ? 1 : 0); // +1 for newline
      if (bytes + size > maxBytes) {
        hitBytes = true;
        break;
      }
      out.push(lines[i]);
      bytes += size;
    }
  } else {
    for (i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
      const size =
        Buffer.byteLength(lines[i], 'utf-8') + (out.length > 0 ? 1 : 0);
      if (bytes + size > maxBytes) {
        hitBytes = true;
        break;
      }
      out.unshift(lines[i]);
      bytes += size;
    }
  }

  const removedLines = hitBytes
    ? Math.floor((totalBytes - bytes) / (bytes / out.length))
    : lines.length - out.length;
  const unit = hitBytes ? 'bytes' : 'lines';
  const preview = out.join('\n');

  const hint = `The tool call succeeded but the output was truncated. Full output saved to: ${outputPath}

To read the full output, use one of these commands:
  - Read first 200 lines: head -200 "${outputPath}"
  - Read last 200 lines: tail -200 "${outputPath}"
  - Read lines 201-400: sed -n '201,400p' "${outputPath}"
  - Read entire file: cat "${outputPath}" (use with caution for large files)`;

  const content =
    direction === 'head'
      ? `${preview}\n\n...${removedLines} ${unit} truncated...\n\n${hint}`
      : `...${removedLines} ${unit} truncated...\n\n${hint}\n\n${preview}`;

  logger.info(
    {
      outputPath,
      originalLines: lines.length,
      truncatedLines: out.length,
      removedLines,
      originalBytes: totalBytes,
      truncatedBytes: bytes,
      direction,
      hitBytes,
    },
    'Tool output truncated',
  );

  return {
    content,
    truncated: true,
    outputPath,
    removedLines,
    removedBytes: hitBytes ? totalBytes - bytes : undefined,
  };
}

/**
 * Clean up old tool output files.
 * Removes files older than RETENTION_MS (7 days).
 */
export function cleanupOldOutputs(): void {
  if (!fs.existsSync(TOOL_OUTPUT_DIR)) return;

  const now = Date.now();
  const cutoff = now - RETENTION_MS;

  logger.debug(
    { cutoff, retentionMs: RETENTION_MS },
    'Starting cleanup of old tool outputs',
  );

  try {
    const files = fs.readdirSync(TOOL_OUTPUT_DIR);
    let deleted = 0;
    let checked = 0;

    for (const file of files) {
      if (!file.startsWith('tool_')) continue;
      checked++;

      const filePath = path.join(TOOL_OUTPUT_DIR, file);
      const stats = fs.statSync(filePath);

      // Extract timestamp from filename: tool_{timestamp}_{uuid}.txt
      const timestamp = parseInt(file.split('_')[1] || '0');

      if (timestamp < cutoff || stats.mtimeMs < cutoff) {
        try {
          fs.unlinkSync(filePath);
          deleted++;
          logger.debug(
            {
              filePath,
              age: Math.floor((now - timestamp) / 86400000) + 'days',
            },
            'Deleted old tool output',
          );
        } catch (err) {
          logger.warn({ err, filePath }, 'Failed to delete old tool output');
        }
      }
    }

    if (deleted > 0) {
      logger.info({ checked, deleted }, 'Cleaned up old tool output files');
    } else {
      logger.debug({ checked }, 'No old tool output files to clean up');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to cleanup tool output files');
  }
}

/**
 * Get the full content from a truncated output file.
 */
export function getFullOutput(outputPath: string): string | null {
  try {
    if (fs.existsSync(outputPath)) {
      const content = fs.readFileSync(outputPath, 'utf-8');
      logger.debug(
        { outputPath, size: Buffer.byteLength(content) },
        'Retrieved full tool output',
      );
      return content;
    }
  } catch (err) {
    logger.error({ err, outputPath }, 'Failed to read full tool output');
  }
  return null;
}
