import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'fs';
import path from 'path';
import * as schema from './schema.js';

const dbs = new Map<string, ReturnType<typeof drizzle<typeof schema>>>();

/**
 * @deprecated Session databases are deprecated. Session data is now stored in the main database.
 * This function is kept for backward compatibility during migration period.
 */
export async function getSessionDb(
  dbPath: string,
): Promise<ReturnType<typeof drizzle<typeof schema>>> {
  const existing = dbs.get(dbPath);
  if (existing) return existing;

  // Ensure directory exists
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const sqlite = new Database(dbPath);
  const db = drizzle(sqlite, { schema });
  dbs.set(dbPath, db);
  return db;
}

/**
 * @deprecated Session databases are deprecated.
 */
export function closeSessionDb(dbPath: string): void {
  const db = dbs.get(dbPath);
  if (db) {
    // Better-sqlite3 has sync API, just close and remove from map
    const sqlite = db.$client as Database.Database;
    try {
      sqlite.close();
    } catch {
      // Ignore close errors
    }
    dbs.delete(dbPath);
  }
}

/**
 * @deprecated Session databases are deprecated.
 */
export function closeAllSessionDbs(): void {
  for (const [path, db] of dbs) {
    const sqlite = db.$client as Database.Database;
    try {
      sqlite.close();
    } catch {
      // Ignore close errors
    }
  }
  dbs.clear();
}
