import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'fs';
import path from 'path';
import * as schema from './schema.js';
import { migrateNewSessionDb } from '../../../scripts/migrate.js';

const dbs = new Map<string, ReturnType<typeof drizzle<typeof schema>>>();

export async function getSessionDb(
  dbPath: string,
): Promise<ReturnType<typeof drizzle<typeof schema>>> {
  const existing = dbs.get(dbPath);
  if (existing) return existing;

  // Check if this is a new database
  const isNewDb = !fs.existsSync(dbPath);

  // Ensure directory exists
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // If new, run migrations first
  if (isNewDb) {
    await migrateNewSessionDb(dbPath);
  }

  const sqlite = new Database(dbPath);
  const db = drizzle(sqlite, { schema });
  dbs.set(dbPath, db);
  return db;
}

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
