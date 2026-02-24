import type { Lock, StateAdapter } from 'chat';
import Database from 'better-sqlite3';

interface SQLiteLock extends Lock {
  expiresAt: number;
  threadId: string;
  token: string;
}

/**
 * SQLite-backed state adapter for Chat SDK.
 *
 * Uses the existing better-sqlite3 database for persistence.
 * Stores subscriptions, locks, and cache in separate tables.
 *
 * This allows Chat SDK to use your existing SQLite database
 * instead of requiring Redis.
 */
export class SQLiteStateAdapter implements StateAdapter {
  private db: Database.Database | null = null;
  private connected = false;
  private dbPath: string;

  constructor(dbPath: string = './data/chat-sdk-state.db') {
    this.dbPath = dbPath;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    // Use better-sqlite3 (synchronous API, but wrapped in async for interface compatibility)
    this.db = new Database(this.dbPath);

    // Enable WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');

    // Create tables if they don't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_sdk_subscriptions (
        thread_id TEXT PRIMARY KEY,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS chat_sdk_locks (
        thread_id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE TABLE IF NOT EXISTS chat_sdk_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Index for faster expired item cleanup
      CREATE INDEX IF NOT EXISTS idx_locks_expires ON chat_sdk_locks(expires_at);
      CREATE INDEX IF NOT EXISTS idx_cache_expires ON chat_sdk_cache(expires_at);
    `);

    this.connected = true;

    // Clean up any expired items on connect
    this.cleanupExpired();
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.connected = false;
  }

  async subscribe(threadId: string): Promise<void> {
    this.ensureConnected();

    const stmt = this.db!.prepare(
      `INSERT OR REPLACE INTO chat_sdk_subscriptions (thread_id) VALUES (?)`,
    );
    stmt.run(threadId);
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.ensureConnected();

    const stmt = this.db!.prepare(
      `DELETE FROM chat_sdk_subscriptions WHERE thread_id = ?`,
    );
    stmt.run(threadId);
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    this.ensureConnected();

    const stmt = this.db!.prepare(
      `SELECT 1 FROM chat_sdk_subscriptions WHERE thread_id = ?`,
    );
    const result = stmt.get(threadId);
    return result !== undefined;
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    this.ensureConnected();

    // Clean up expired locks first
    this.cleanupExpiredLocks();

    // Check if already locked
    const checkStmt = this.db!.prepare(
      `SELECT token, expires_at FROM chat_sdk_locks WHERE thread_id = ?`,
    );
    const existing = checkStmt.get(threadId) as
      | { token: string; expires_at: number }
      | undefined;

    if (existing && existing.expires_at > Date.now()) {
      return null; // Already locked and not expired
    }

    // Create new lock
    const lock: SQLiteLock = {
      threadId,
      token: generateToken(),
      expiresAt: Date.now() + ttlMs,
    };

    const insertStmt = this.db!.prepare(
      `INSERT OR REPLACE INTO chat_sdk_locks (thread_id, token, expires_at) VALUES (?, ?, ?)`,
    );
    insertStmt.run(threadId, lock.token, lock.expiresAt);

    return lock;
  }

  async releaseLock(lock: Lock): Promise<void> {
    this.ensureConnected();

    const stmt = this.db!.prepare(
      `DELETE FROM chat_sdk_locks WHERE thread_id = ? AND token = ?`,
    );
    stmt.run(lock.threadId, lock.token);
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    this.ensureConnected();

    // Check if lock still exists and matches
    const checkStmt = this.db!.prepare(
      `SELECT expires_at FROM chat_sdk_locks WHERE thread_id = ? AND token = ?`,
    );
    const existing = checkStmt.get(lock.threadId, lock.token) as
      | { expires_at: number }
      | undefined;

    if (!existing) {
      return false; // Lock doesn't exist or token doesn't match
    }

    if (existing.expires_at < Date.now()) {
      // Lock has already expired, clean it up
      const deleteStmt = this.db!.prepare(
        `DELETE FROM chat_sdk_locks WHERE thread_id = ?`,
      );
      deleteStmt.run(lock.threadId);
      return false;
    }

    // Extend the lock
    const newExpiresAt = Date.now() + ttlMs;
    const updateStmt = this.db!.prepare(
      `UPDATE chat_sdk_locks SET expires_at = ? WHERE thread_id = ? AND token = ?`,
    );
    updateStmt.run(newExpiresAt, lock.threadId, lock.token);

    return true;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    this.ensureConnected();

    const stmt = this.db!.prepare(
      `SELECT value, expires_at FROM chat_sdk_cache WHERE key = ?`,
    );
    const result = stmt.get(key) as
      | { value: string; expires_at: number | null }
      | undefined;

    if (!result) {
      return null;
    }

    // Check if expired
    if (result.expires_at !== null && result.expires_at <= Date.now()) {
      const deleteStmt = this.db!.prepare(
        `DELETE FROM chat_sdk_cache WHERE key = ?`,
      );
      deleteStmt.run(key);
      return null;
    }

    try {
      return JSON.parse(result.value) as T;
    } catch {
      return result.value as unknown as T;
    }
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.ensureConnected();

    const serialized = JSON.stringify(value);
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;

    const stmt = this.db!.prepare(
      `INSERT OR REPLACE INTO chat_sdk_cache (key, value, expires_at) VALUES (?, ?, ?)`,
    );
    stmt.run(key, serialized, expiresAt);
  }

  async delete(key: string): Promise<void> {
    this.ensureConnected();

    const stmt = this.db!.prepare(`DELETE FROM chat_sdk_cache WHERE key = ?`);
    stmt.run(key);
  }

  private ensureConnected(): void {
    if (!this.connected || !this.db) {
      throw new Error(
        'SQLiteStateAdapter is not connected. Call connect() first.',
      );
    }
  }

  private cleanupExpiredLocks(): void {
    const stmt = this.db!.prepare(
      `DELETE FROM chat_sdk_locks WHERE expires_at <= ?`,
    );
    stmt.run(Date.now());
  }

  private cleanupExpired(): void {
    const now = Date.now();

    // Clean expired locks
    const lockStmt = this.db!.prepare(
      `DELETE FROM chat_sdk_locks WHERE expires_at <= ?`,
    );
    lockStmt.run(now);

    // Clean expired cache entries
    const cacheStmt = this.db!.prepare(
      `DELETE FROM chat_sdk_cache WHERE expires_at IS NOT NULL AND expires_at <= ?`,
    );
    cacheStmt.run(now);
  }

  // Utility methods for debugging/monitoring

  getSubscriptionCount(): number {
    this.ensureConnected();
    const stmt = this.db!.prepare(
      `SELECT COUNT(*) as count FROM chat_sdk_subscriptions`,
    );
    const result = stmt.get() as { count: number };
    return result.count;
  }

  getLockCount(): number {
    this.ensureConnected();
    this.cleanupExpiredLocks();
    const stmt = this.db!.prepare(
      `SELECT COUNT(*) as count FROM chat_sdk_locks`,
    );
    const result = stmt.get() as { count: number };
    return result.count;
  }

  getCacheSize(): number {
    this.ensureConnected();
    const stmt = this.db!.prepare(
      `SELECT COUNT(*) as count FROM chat_sdk_cache WHERE expires_at IS NULL OR expires_at > ?`,
    );
    const result = stmt.get(Date.now()) as { count: number };
    return result.count;
  }
}

function generateToken(): string {
  return `sqlite_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

export function createSQLiteState(dbPath?: string): SQLiteStateAdapter {
  return new SQLiteStateAdapter(dbPath);
}
