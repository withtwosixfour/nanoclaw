import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql/node';
import { eq } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { STORE_DIR, SESSIONS_DIR } from '../src/config.js';
import * as mainSchema from '../src/db/main/schema.js';
import * as sessionSchema from '../src/db/sessions/schema.js';
import { logger } from '../src/logger.js';
import { db as mainDb } from '../src/db/main/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const mainMigrationsFolder = path.join(rootDir, 'drizzle', 'main');

/**
 * Run migrations on a database
 */
export async function runMigrationsOnDb(
  dbPath: string,
  migrationsFolder: string,
  schema: typeof mainSchema,
  dbName: string,
): Promise<void> {
  const isNewDb = !fs.existsSync(dbPath);

  // Ensure directory exists
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const sqlite = createClient({
    url: 'file:' + dbPath,
  });

  const db = drizzle(sqlite, { schema });

  try {
    logger.debug({ db: dbName, path: dbPath }, 'Running migrations');
    await migrate(db, { migrationsFolder });

    if (isNewDb) {
      logger.info(
        { db: dbName, path: dbPath },
        'Created and migrated new database',
      );
    } else {
      logger.debug({ db: dbName }, 'Migrations applied successfully');
    }
  } catch (error) {
    logger.error(
      { db: dbName, err: JSON.stringify(error, Object.keys(error as any)) },
      'Migration failed',
    );
    throw error;
  } finally {
    sqlite.close();
  }
}

/**
 * Migrate the main database
 */
export async function migrateMainDb(): Promise<void> {
  const dbPath = path.join(STORE_DIR, 'main.db');

  logger.info('Migrating main database');
  await runMigrationsOnDb(dbPath, mainMigrationsFolder, mainSchema, 'main');
}

/**
 * Find all session database paths
 */
export function findSessionDbs(): string[] {
  const sessionDbs: string[] = [];

  if (!fs.existsSync(SESSIONS_DIR)) {
    return sessionDbs;
  }

  const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const dbPath = path.join(SESSIONS_DIR, entry.name, 'conversation.db');
      if (fs.existsSync(dbPath)) {
        sessionDbs.push(dbPath);
      }
    }
  }

  return sessionDbs;
}

/**
 * Migrate data from individual session databases to the main database
 */
export async function migrateSessionDataToMainDb(): Promise<void> {
  const sessionDbs = findSessionDbs();

  if (sessionDbs.length === 0) {
    logger.info('No session databases to migrate to main DB');
    return;
  }

  logger.info(
    { count: sessionDbs.length },
    'Migrating session data to main database',
  );

  for (const dbPath of sessionDbs) {
    const jid = path.basename(path.dirname(dbPath));
    const sessionFilePath = path.join(path.dirname(dbPath), 'session.json');

    // Read session metadata to get agentId and sessionId
    let agentId = 'unknown';
    let sessionId = jid;

    try {
      if (fs.existsSync(sessionFilePath)) {
        const sessionData = JSON.parse(
          fs.readFileSync(sessionFilePath, 'utf-8'),
        ) as {
          agentId?: string;
          sessionId?: string;
        };
        agentId = sessionData.agentId || 'unknown';
        sessionId = sessionData.sessionId || jid;
      }
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to read session metadata');
    }

    // Check if we already have data for this session in main DB
    const existingResult = await mainDb
      .select({ count: mainSchema.conversationHistory.id })
      .from(mainSchema.conversationHistory)
      .where(eq(mainSchema.conversationHistory.sessionId, sessionId));

    const existingCount = existingResult.length;

    if (existingCount > 0) {
      logger.info(
        { jid, sessionId, existingCount },
        'Session data already exists in main DB, skipping migration',
      );
      continue;
    }

    // Connect to old session database
    const sqlite = createClient({ url: 'file:' + dbPath });
    const sessionDb = drizzle(sqlite, { schema: sessionSchema });

    try {
      // Get all conversation history from the session DB
      const rows = await sessionDb
        .select()
        .from(sessionSchema.conversationHistory)
        .where(eq(sessionSchema.conversationHistory.sessionId, sessionId));

      if (rows.length === 0) {
        logger.info({ jid, sessionId }, 'No conversation data to migrate');
        sqlite.close();
        continue;
      }

      // Insert into main DB
      for (const row of rows) {
        await mainDb.insert(mainSchema.conversationHistory).values({
          sessionId: row.sessionId,
          jid: jid,
          agentId: agentId,
          role: row.role as 'user' | 'assistant' | 'system' | 'tool',
          content: row.content,
          toolCalls: row.toolCalls,
          toolResults: row.toolResults,
          tokenCount: row.tokenCount,
          createdAt: row.createdAt,
          isCompacted: row.isCompacted,
          compactedAt: row.compactedAt,
          isCompactedSummary: row.isCompactedSummary,
          provider: row.provider,
          model: row.model,
        });
      }

      logger.info(
        { jid, sessionId, migratedCount: rows.length, agentId },
        'Migrated session data to main DB',
      );
    } catch (err) {
      logger.error({ jid, sessionId, err }, 'Failed to migrate session data');
    } finally {
      sqlite.close();
    }
  }

  logger.info('Session data migration complete');
}

/**
 * Run all migrations (main + migrate session data)
 * Call this on startup
 */
export async function runMigrations(): Promise<void> {
  logger.info('Starting database migrations');

  try {
    // Migrate main database (this creates the conversation_history table)
    await migrateMainDb();

    // Migrate data from old session databases to main DB
    await migrateSessionDataToMainDb();

    logger.info('All migrations complete');
  } catch (error) {
    logger.error(
      { err: JSON.stringify(error, Object.keys(error as any)) },
      'Migration failed',
    );
    throw error;
  }
}

/**
 * CLI entry point
 */
async function main(): Promise<void> {
  logger.info('🗄️  NanoClaw Database Migration');

  try {
    await runMigrations();
    logger.info('✅ All migrations complete!');
    process.exit(0);
  } catch (error) {
    logger.fatal('❌ Migration failed');
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === fileURLToPath(import.meta.resolve('./migrate.ts'))) {
  main();
}
