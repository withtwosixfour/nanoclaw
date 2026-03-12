import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ModelMessage } from 'ai';

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    get SESSIONS_DIR() {
      return (global as any).__TEST_MOCK_SESSIONS_DIR__ || actual.SESSIONS_DIR;
    },
    get STORE_DIR() {
      return (global as any).__TEST_MOCK_STORE_DIR__ || actual.STORE_DIR;
    },
  };
});

vi.mock('../router.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../router.js')>();
  return {
    ...actual,
    getSessionPath: (threadId: string) => {
      const sanitizedId = threadId.replace(/[:@]/g, '_');
      const baseDir =
        (global as any).__TEST_MOCK_SESSIONS_DIR__ ||
        path.join(process.cwd(), 'sessions');
      return path.join(baseDir, sanitizedId);
    },
    getAgentPath: (agentId: string) =>
      path.join(process.cwd(), 'agents', agentId),
  };
});

vi.mock('../db/main/client.js', async () => {
  const { drizzle } = await import('drizzle-orm/libsql/node');
  const { createClient } = await import('@libsql/client/node');
  const fs = await import('fs');
  const path = await import('path');

  const storeDir = (global as any).__TEST_MOCK_STORE_DIR__ || process.cwd();
  const testDbPath = path.join(storeDir, 'test_main.db');
  fs.mkdirSync(path.dirname(testDbPath), { recursive: true });

  const sqlite = createClient({ url: 'file:' + testDbPath });
  const schema = await import('../db/main/schema.js');
  const testDb = drizzle(sqlite, { schema });

  return {
    db: testDb,
  };
});

import { db } from '../db/main/client.js';
import { conversationHistory } from '../db/main/schema.js';
import { convertLegacyRowToMessage } from './message-store.js';
import { loadMessages, saveMessage } from './session-store.js';

function createTempProjectDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-session-store-test-'));
}

function cleanup(projectDir: string): void {
  fs.rmSync(projectDir, { recursive: true, force: true });
}

async function setupTestDb(): Promise<void> {
  const sqlite = (db as any).$client;
  await sqlite.execute(`
    CREATE TABLE IF NOT EXISTS conversation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      jid TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      message TEXT,
      content TEXT,
      tool_calls TEXT,
      tool_results TEXT,
      token_count INTEGER,
      created_at TEXT NOT NULL,
      is_compacted INTEGER DEFAULT 0,
      compacted_at TEXT,
      is_compacted_summary INTEGER DEFAULT 0,
      provider TEXT,
      model TEXT
    );
  `);
  try {
    await sqlite.execute(
      'ALTER TABLE conversation_history ADD COLUMN message TEXT;',
    );
  } catch {
    // Column already exists.
  }
  await sqlite.execute(
    'CREATE INDEX IF NOT EXISTS idx_conversation_session ON conversation_history(session_id);',
  );
  await sqlite.execute(
    'CREATE INDEX IF NOT EXISTS idx_conversation_jid ON conversation_history(jid);',
  );
  await sqlite.execute(
    'CREATE INDEX IF NOT EXISTS idx_conversation_agent ON conversation_history(agent_id);',
  );
  await sqlite.execute(
    'CREATE INDEX IF NOT EXISTS idx_conversation_created ON conversation_history(created_at);',
  );
  await sqlite.execute(
    'CREATE INDEX IF NOT EXISTS idx_conversation_compacted ON conversation_history(session_id, is_compacted);',
  );
}

describe('session-store canonical message storage', () => {
  let projectDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    projectDir = createTempProjectDir();
    process.chdir(projectDir);

    (global as any).__TEST_MOCK_SESSIONS_DIR__ = path.join(
      projectDir,
      'sessions',
    );
    (global as any).__TEST_MOCK_STORE_DIR__ = path.join(projectDir, 'store');

    fs.mkdirSync((global as any).__TEST_MOCK_SESSIONS_DIR__, {
      recursive: true,
    });
    fs.mkdirSync((global as any).__TEST_MOCK_STORE_DIR__, { recursive: true });

    await setupTestDb();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanup(projectDir);
  });

  it('round-trips assistant text and tool calls via canonical message JSON', async () => {
    const sessionId = `session-assistant-${Date.now()}-${Math.random()}`;
    const assistantMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I can do that.' },
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'create_or_update_agent',
          input: { id: 'coding-agent', trigger: 'code' },
        },
      ],
    } satisfies ModelMessage;

    const toolMessage = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'create_or_update_agent',
          input: { id: 'coding-agent', trigger: 'code' },
          output: { ok: true },
          dynamic: true,
        },
      ],
    } as unknown as ModelMessage;

    await saveMessage('jid-1', 'agent-1', sessionId, assistantMessage, null);
    await saveMessage('jid-1', 'agent-1', sessionId, toolMessage, null);

    const messages = await loadMessages('jid-1', sessionId);

    expect(messages).toEqual([assistantMessage, toolMessage]);
  });

  it('truncates large tool outputs before writing canonical message JSON', async () => {
    const sessionId = `session-tool-${Date.now()}-${Math.random()}`;
    const largeOutput = Array.from(
      { length: 600 },
      (_, i) => `Line ${i + 1}: ${'x'.repeat(100)}`,
    ).join('\n');

    const assistantMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading the file now.' },
        {
          type: 'tool-call',
          toolCallId: 'call-2',
          toolName: 'read_file',
          input: { filePath: 'src/index.ts' },
        },
      ],
    } satisfies ModelMessage;

    const message = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-2',
          toolName: 'read_file',
          input: { filePath: 'src/index.ts' },
          output: largeOutput,
          dynamic: true,
        },
      ],
    } as unknown as ModelMessage;

    await saveMessage('jid-1', 'agent-1', sessionId, assistantMessage, null);
    await saveMessage('jid-1', 'agent-1', sessionId, message, null);

    const messages = await loadMessages('jid-1', sessionId);
    const loaded = messages[1] as any;

    expect(loaded.role).toBe('tool');
    expect(loaded.content[0].output).toContain(
      'The tool call succeeded but the output was truncated',
    );
  });

  it('reconstructs assistant tool calls from legacy split columns', () => {
    const message = convertLegacyRowToMessage({
      role: 'assistant',
      content: 'Working on it.',
      toolCalls: JSON.stringify([
        {
          toolName: 'create_or_update_agent',
          toolCallId: 'call-3',
          input: { id: 'agent-3' },
        },
      ]),
      toolResults: null,
    });

    expect(message).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Working on it.' },
        {
          type: 'tool-call',
          toolName: 'create_or_update_agent',
          toolCallId: 'call-3',
          input: { id: 'agent-3' },
        },
      ],
    });
  });

  it('preserves orphan assistant tool calls until compaction rewrites history', async () => {
    const sessionId = `session-orphan-${Date.now()}-${Math.random()}`;
    await db.insert(conversationHistory).values({
      sessionId,
      jid: 'jid-1',
      agentId: 'agent-1',
      role: 'assistant',
      message: JSON.stringify({
        role: 'assistant',
        content: [
          { type: 'text', text: 'Started work.' },
          {
            type: 'tool-call',
            toolCallId: 'call-orphan',
            toolName: 'create_or_update_agent',
            input: { id: 'agent-orphan' },
          },
        ],
      }),
      content: null,
      toolCalls: null,
      toolResults: null,
      tokenCount: null,
      createdAt: new Date().toISOString(),
    });

    const messages = await loadMessages('jid-1', sessionId);

    expect(messages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Started work.' },
          {
            type: 'tool-call',
            toolCallId: 'call-orphan',
            toolName: 'create_or_update_agent',
            input: { id: 'agent-orphan' },
          },
        ],
      },
    ]);
  });
});
