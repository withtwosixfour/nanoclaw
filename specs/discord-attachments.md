# Discord Attachments Implementation Specification

## Overview

This specification details the implementation of Discord attachment handling in NanoClaw, including file storage, database persistence, prompt injection, and vision-capable model support.

## Goals

1. Download and store Discord attachments permanently in the filesystem
2. Reference attachments by absolute path in conversations
3. Automatically inject attached images into prompts for vision-capable models
4. Make the Read tool smart enough to detect and return image data
5. Maintain clean separation between vision and non-vision model handling

## Architecture

### Storage Location

- **Path**: `store/attachments/`
- **Naming Convention**: `{sanitized-filename}---{uuid}.{ext}`
  - Example: `document---a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf`
- **File Permissions**: 0600 (user read/write only)
- **Directory Permissions**: 0700

### Database Schema

#### New Table: `attachments`

```sql
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  filename TEXT NOT NULL,
  path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (message_id, chat_jid) REFERENCES messages(id, chat_jid)
);
```

### Data Flow

```
Discord Message Received
    ↓
Download Attachment(s) from Discord CDN
    ↓
Save to store/attachments/ with UUID naming
    ↓
Store metadata in attachments table
    ↓
Inject media notes into message content
    ↓
Store message in database
    ↓
Agent processes message
    ↓
Vision Detection:
    ├─ Vision Model: Extract images from media notes → inject base64
    └─ Non-Vision: Pass media notes as text
```

## Implementation

### 1. Type Definitions (`src/types.ts`)

Add `Attachment` interface and update `NewMessage`:

```typescript
export interface Attachment {
  id: string; // UUID
  filename: string; // Original filename
  path: string; // Absolute filesystem path
  mimeType: string; // MIME type (e.g., "image/png")
  size: number; // File size in bytes
  createdAt: string; // ISO timestamp
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  attachments?: Attachment[]; // NEW
}
```

### 2. Model Configuration (`src/agent-runner/model-config.ts`)

Add vision capability flag to ModelConfig:

```typescript
export interface ModelConfig {
  provider: string;
  modelName: string;
  contextWindow: number;
  maxOutputTokens: number;
  compactionThresholdPercent: number;
  supportsVision: boolean; // NEW
}

// Update configs with vision capability
const MODEL_CONFIGS: Record<string, ModelConfig> = {
  'opencode-zen:kimi-k2.5': {
    ...DEFAULT_MODEL_CONFIG,
    supportsVision: true, // Set based on actual model capability
  },
  // Add other models as needed
};
```

### 3. Attachment Storage Module (`src/attachments/store.ts`)

**Purpose**: Handle file storage operations

```typescript
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
    .replace(/[^a-zA-Z0-9._-]/g, '_') // Replace unsafe chars with underscore
    .replace(/_{2,}/g, '_') // Collapse multiple underscores
    .substring(0, 100); // Limit length
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

  // Fall back to filename extension
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
  // Ensure attachments directory exists with secure permissions
  await fs.mkdir(ATTACHMENTS_DIR, { recursive: true, mode: 0o700 });

  // Generate unique ID and filename
  const uuid = randomUUID();
  const sanitized = sanitizeFilename(path.parse(originalFilename).name);
  const ext = getFileExtension(mimeType, originalFilename);
  const id = sanitized ? `${sanitized}---${uuid}${ext}` : `${uuid}${ext}`;

  // Full path
  const filePath = path.join(ATTACHMENTS_DIR, id);

  // Write file with secure permissions (user only)
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
```

### 4. Image Detection Module (`src/attachments/images.ts`)

**Purpose**: Detect and load images from media notes and file paths

```typescript
import fs from 'fs/promises';

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tiff',
  '.heic',
  '.heif',
]);

const MEDIA_NOTE_PATTERN = /\[media attached:\s*([^\s(]+)\s*\(([^)]+)\)\]/g;

export interface ImageData {
  base64: string;
  mediaType: string;
  path: string;
}

/**
 * Check if a file path has an image extension
 */
export function isImageFile(filePath: string): boolean {
  const ext = filePath.toLowerCase().slice(filePath.lastIndexOf('.'));
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Detect MIME type from file extension
 */
function getMimeTypeFromExtension(filePath: string): string {
  const extToMime: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
  };

  const ext = filePath.toLowerCase().slice(filePath.lastIndexOf('.'));
  return extToMime[ext] || 'application/octet-stream';
}

/**
 * Extract image paths from media notes in prompt text
 */
export function extractImagePathsFromMediaNotes(
  prompt: string,
): Array<{ path: string; mimeType: string }> {
  const images: Array<{ path: string; mimeType: string }> = [];
  const matches = [...prompt.matchAll(MEDIA_NOTE_PATTERN)];

  for (const match of matches) {
    const filePath = match[1];
    const mimeType = match[2];

    if (isImageFile(filePath)) {
      images.push({ path: filePath, mimeType });
    }
  }

  return images;
}

/**
 * Load image file and convert to base64
 */
export async function loadImageAsBase64(
  filePath: string,
  mimeType: string,
): Promise<ImageData> {
  const buffer = await fs.readFile(filePath);
  const base64 = buffer.toString('base64');

  return {
    base64,
    mediaType: mimeType || getMimeTypeFromExtension(filePath),
    path: filePath,
  };
}

/**
 * Detect and load all images from prompt media notes
 * Returns array of image data ready for model injection
 */
export async function detectAndLoadImages(
  prompt: string,
): Promise<ImageData[]> {
  const imagePaths = extractImagePathsFromMediaNotes(prompt);

  const images: ImageData[] = [];
  for (const { path, mimeType } of imagePaths) {
    try {
      const imageData = await loadImageAsBase64(path, mimeType);
      images.push(imageData);
    } catch (err) {
      // Log error but don't fail - image might have been deleted
      console.warn(`Failed to load image ${path}:`, err);
    }
  }

  return images;
}

/**
 * Detect if a file is an image and load it
 * Used by the Read tool
 */
export async function readImageFile(
  filePath: string,
): Promise<ImageData | null> {
  if (!isImageFile(filePath)) {
    return null;
  }

  try {
    const mimeType = getMimeTypeFromExtension(filePath);
    return await loadImageAsBase64(filePath, mimeType);
  } catch (err) {
    console.warn(`Failed to read image ${filePath}:`, err);
    return null;
  }
}
```

### 5. Database Updates (`src/db.ts`)

**Schema Migration** (in `createSchema`):

```typescript
database.exec(`
  -- Existing tables...
  
  -- Attachments table for storing file metadata
  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    filename TEXT NOT NULL,
    path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (message_id, chat_jid) REFERENCES messages(id, chat_jid)
  );
  CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id, chat_jid);
`);
```

**Storage Functions**:

```typescript
export function storeAttachment(
  attachment: Attachment,
  messageId: string,
  chatJid: string,
): void {
  db.prepare(
    `INSERT INTO attachments (id, message_id, chat_jid, filename, path, mime_type, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    attachment.id,
    messageId,
    chatJid,
    attachment.filename,
    attachment.path,
    attachment.mimeType,
    attachment.size,
    attachment.createdAt,
  );
}

export function getAttachmentsForMessage(
  messageId: string,
  chatJid: string,
): Attachment[] {
  const rows = db
    .prepare(
      `SELECT id, filename, path, mime_type as mimeType, size, created_at as createdAt
     FROM attachments WHERE message_id = ? AND chat_jid = ?`,
    )
    .all(messageId, chatJid) as Attachment[];
  return rows;
}
```

### 6. Discord Channel Updates (`src/channels/discord.ts`)

**Modified Message Handler**:

```typescript
// In the message handler, replace the placeholder logic:

import { saveAttachment, buildMediaNote } from '../attachments/store.js';
import { storeAttachment } from '../db.js';

// Handle attachments - download and store
if (message.attachments.size > 0) {
  const attachments: Attachment[] = [];
  const mediaNotes: string[] = [];

  for (const att of message.attachments.values()) {
    try {
      // Download from Discord CDN
      const response = await fetch(att.url);
      if (!response.ok) {
        console.warn(
          `Failed to download attachment ${att.name}: ${response.status}`,
        );
        mediaNotes.push(`[File: ${att.name || 'file'} - download failed]`);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const mimeType = att.contentType || 'application/octet-stream';

      // Save to filesystem
      const attachment = await saveAttachment(
        buffer,
        att.name || 'attachment',
        mimeType,
      );
      attachments.push(attachment);

      // Build media note
      mediaNotes.push(buildMediaNote(attachment));
    } catch (err) {
      console.error(`Error processing attachment ${att.name}:`, err);
      mediaNotes.push(`[File: ${att.name || 'file'} - error processing]`);
    }
  }

  // Store attachment metadata in DB
  for (const att of attachments) {
    storeAttachment(att, msgId, chatJid);
  }

  // Append media notes to content
  if (mediaNotes.length > 0) {
    if (content) {
      content = `${content}\n\n${mediaNotes.join('\n')}`;
    } else {
      content = mediaNotes.join('\n');
    }
  }
}

// Deliver message with attachments
this.opts.onMessage(chatJid, {
  id: msgId,
  chat_jid: chatJid,
  sender,
  sender_name: senderName,
  content,
  timestamp,
  is_from_me: false,
  attachments, // Pass attachments for potential direct use
});
```

### 7. Agent Runtime Updates (`src/agent-runner/runtime.ts`)

**Vision Model Support in `runQuery()`**:

```typescript
import { detectAndLoadImages } from '../attachments/images.js';

// In runQuery function, before streamText call:

// Check if model supports vision
const modelConfig = getModelConfig(input.modelProvider, input.modelName);
const supportsVision = modelConfig.supportsVision;

let userContent: UserContent;

if (supportsVision) {
  // Detect and load images from media notes in the prompt
  const images = await detectAndLoadImages(prompt);

  if (images.length > 0) {
    // Construct multimodal content
    userContent = [
      { type: 'text', text: prompt },
      ...images.map((img) => ({
        type: 'image' as const,
        image: img.base64,
        mediaType: img.mediaType,
      })),
    ];
  } else {
    userContent = prompt;
  }
} else {
  // Non-vision model: just pass the text (media notes remain as text)
  userContent = prompt;
}

// Update message construction
messages.push({ role: 'user', content: userContent });

// Call streamText with images if present
const result = streamText({
  model: wrappedModel,
  messages,
  tools,
  maxOutputTokens: config.maxOutputTokens,
  // ... rest of config
});
```

### 8. Read Tool Enhancement (`src/agent-runner/tools/fs.ts`)

**Smart Image Detection**:

```typescript
import { readImageFile, isImageFile } from '../../attachments/images.js';
import { getModelConfig } from '../model-config.js';

// In the Read tool implementation:

execute: async (params, context) => {
  const filePath = params.filePath;

  // Check if file exists
  // ... existing code ...

  const content = await fs.readFile(filePath);

  // Check if this is an image file
  if (isImageFile(filePath)) {
    // Get model config to check vision support
    // Note: modelProvider and modelName should be passed in context or determined from current session
    const modelConfig = getModelConfig(
      context.modelProvider,
      context.modelName,
    );

    if (modelConfig.supportsVision) {
      // Return as base64 image for vision models
      const mimeType = getMimeTypeFromExtension(filePath);
      return {
        type: 'image',
        base64: content.toString('base64'),
        mimeType,
        path: filePath,
      };
    } else {
      // Non-vision model: return placeholder
      return {
        type: 'text',
        content: `[Image file: ${filePath} - ${content.length} bytes. This model does not support image viewing.]`,
      };
    }
  }

  // Regular file handling (existing code)
  // ...
};
```

### 9. Index Integration (`src/index.ts`)

**Store Attachments**:

```typescript
import { storeAttachment } from './db.js';

// In onMessage handler:

onMessage: (chatJid: string, msg: NewMessage) => {
  // Store message
  storeMessage(msg);

  // Store attachment metadata if present
  if (msg.attachments && msg.attachments.length > 0) {
    for (const att of msg.attachments) {
      storeAttachment(att, msg.id, chatJid);
    }
  }

  ensureSessionForJid(chatJid);
},
```

## File Structure

```
app/
├── src/
│   ├── attachments/
│   │   ├── store.ts      # Attachment storage operations
│   │   └── images.ts     # Image detection and loading
│   ├── types.ts          # Updated with Attachment interface
│   ├── config.ts         # ATTACHMENTS_DIR constant
│   ├── db.ts             # Attachments table and functions
│   ├── channels/
│   │   └── discord.ts    # Updated with download logic
│   ├── agent-runner/
│   │   ├── runtime.ts    # Vision model support
│   │   ├── model-config.ts # Vision capability flags
│   │   └── tools/
│   │       └── fs.ts     # Smart image detection
│   └── index.ts          # Integration
└── store/
    └── attachments/      # File storage directory
```

## Security Considerations

1. **File Permissions**: 0600 ensures only the user can read attachments
2. **Directory Permissions**: 0700 restricts directory access
3. **Path Sanitization**: Filenames are sanitized to prevent path traversal
4. **No URL Access**: Only local filesystem paths are accessed
5. **Size Validation**: While no explicit limit is enforced, memory usage is bounded by Buffer

## Error Handling

1. **Download Failures**: Log warning, add placeholder note to message
2. **Storage Failures**: Log error, continue without attachment
3. **Image Load Failures**: Log warning, skip that image but continue processing
4. **Missing Files**: Return null or placeholder when file not found

## Testing Strategy

1. **Unit Tests**:
   - `saveAttachment()`: Verify correct naming, permissions
   - `buildMediaNote()`: Verify correct format
   - `detectAndLoadImages()`: Verify parsing and loading
   - `isImageFile()`: Verify extension detection

2. **Integration Tests**:
   - Discord message with single attachment
   - Discord message with multiple attachments
   - Vision model receives image data
   - Non-vision model receives text placeholder
   - Read tool returns image for vision model
   - Read tool returns placeholder for non-vision model

## Future Enhancements (Not in Scope)

1. **Non-vision image understanding**: Generate text descriptions for non-vision models
2. **Attachment cleanup**: Auto-delete old attachments after N days
3. **Other channels**: Extend to WhatsApp, Telegram
4. **File size limits**: Enforce configurable limits
5. **Attachment search**: Index attachment metadata for searching

## Acceptance Criteria

- [ ] Discord attachments are downloaded and stored in `store/attachments/`
- [ ] Files are named `{filename}---{uuid}.{ext}`
- [ ] File permissions are 0600, directory 0700
- [ ] Attachment metadata stored in database
- [ ] Media notes appear in message content: `[media attached: /path/file.png (image/png)]`
- [ ] Vision-capable models receive image data directly in prompt
- [ ] Non-vision models see media notes as text
- [ ] Read tool detects image files and returns appropriate format
- [ ] All file types supported (no filtering)
- [ ] Error handling for failed downloads/storage
