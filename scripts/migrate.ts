import { migrate } from 'drizzle-orm/libsql/migrator';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql/node';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { STORE_DIR, SESSIONS_DIR } from '../src/config.js';
import * as mainSchema from '../src/db/main/schema.js';
import * as sessionSchema from '../src/db/sessions/schema.js';
import { logger } from '../src/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const mainMigrationsFolder = path.join(rootDir, 'drizzle', 'main');
const sessionMigrationsFolder = path.join(rootDir, 'drizzle', 'sessions');

/**
 * Run migrations on a database
 */
export async function runMigrationsOnDb(
  dbPath: string,
  migrationsFolder: string,
  schema: typeof mainSchema | typeof sessionSchema,
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
 * Migrate a single session database
 */
export async function migrateSessionDb(dbPath: string): Promise<void> {
  const jid = path.basename(path.dirname(dbPath));
  await runMigrationsOnDb(
    dbPath,
    sessionMigrationsFolder,
    sessionSchema,
    `session:${jid}`,
  );
}

/**
 * Migrate all existing session databases
 */
export async function migrateAllSessionDbs(): Promise<void> {
  const sessionDbs = findSessionDbs();

  if (sessionDbs.length === 0) {
    logger.info('No existing session databases found');
    return;
  }

  logger.info({ count: sessionDbs.length }, 'Migrating session databases');

  for (const dbPath of sessionDbs) {
    await migrateSessionDb(dbPath);
  }
}

/**
 * Run all migrations (main + all existing sessions)
 * Call this on startup
 */
export async function runMigrations(): Promise<void> {
  logger.info('Starting database migrations');

  try {
    // Migrate main database
    await migrateMainDb();

    // Migrate all existing session databases
    await migrateAllSessionDbs();

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
 * Run migrations on a new session database (called when creating new session)
 */
export async function migrateNewSessionDb(dbPath: string): Promise<void> {
  const jid = path.basename(path.dirname(dbPath));
  await runMigrationsOnDb(
    dbPath,
    sessionMigrationsFolder,
    sessionSchema,
    `session:${jid}`,
  );
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
