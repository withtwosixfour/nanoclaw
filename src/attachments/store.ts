import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { STORE_DIR } from '../config.js';

export const ATTACHMENTS_DIR = path.join(STORE_DIR, 'attachments');

export interface Attachment {
  id: string;
  filename: string;
  path: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

/**
 * Sanitize filename for safe filesystem storage
 * Removes path traversal, special characters, limits length
 */
function sanitizeFilename(filename: string): string {
  return filename
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .substring(0, 100);
}

/**
 * Get file extension from MIME type or filename
 */
function getFileExtension(mimeType: string, filename: string): string {
  const mimeToExt: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'text/html': '.html',
    'text/css': '.css',
    'application/javascript': '.js',
    'application/json': '.json',
    'text/csv': '.csv',
    'application/zip': '.zip',
    'application/gzip': '.gz',
  };

  const fromMime = mimeToExt[mimeType.toLowerCase()];
  if (fromMime) return fromMime;

  const ext = path.extname(filename);
  return ext || '';
}

/**
 * Save attachment buffer to filesystem
 * Returns Attachment metadata
 */
export async function saveAttachment(
  buffer: Buffer,
  originalFilename: string,
  mimeType: string,
): Promise<Attachment> {
  await fs.mkdir(ATTACHMENTS_DIR, { recursive: true, mode: 0o700 });

  const uuid = randomUUID();
  const sanitized = sanitizeFilename(path.parse(originalFilename).name);
  const ext = getFileExtension(mimeType, originalFilename);
  const id = sanitized ? `${sanitized}---${uuid}${ext}` : `${uuid}${ext}`;

  const filePath = path.join(ATTACHMENTS_DIR, id);
  await fs.writeFile(filePath, buffer, { mode: 0o600 });

  return {
    id: uuid,
    filename: originalFilename,
    path: filePath,
    mimeType,
    size: buffer.length,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Build media note string for prompt injection
 * Format: [media attached: /path/to/file.png (image/png)]
 */
export function buildMediaNote(attachment: Attachment): string {
  return `[media attached: ${attachment.path} (${attachment.mimeType})]`;
}
