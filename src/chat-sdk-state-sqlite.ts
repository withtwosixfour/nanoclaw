import type { Lock, StateAdapter } from 'chat';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

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
      logger.debug(
        { dbPath: this.dbPath },
        'SQLiteStateAdapter already connected',
      );
      return;
    }

    logger.info({ dbPath: this.dbPath }, 'SQLiteStateAdapter connecting...');

    // Ensure the directory exists before creating the database
    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });

    // Use better-sqlite3 (synchronous API, but wrapped in async for interface compatibility)
    this.db = new Database(this.dbPath);

    // Enable WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');

    logger.debug(
      { dbPath: this.dbPath },
      'SQLiteStateAdapter database opened, creating tables...',
    );

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

    logger.info(
      { dbPath: this.dbPath },
      'SQLiteStateAdapter connected successfully',
    );

    // Clean up any expired items on connect
    this.cleanupExpired();
  }

  async disconnect(): Promise<void> {
    logger.info({ dbPath: this.dbPath }, 'SQLiteStateAdapter disconnecting...');
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.connected = false;
    logger.info({ dbPath: this.dbPath }, 'SQLiteStateAdapter disconnected');
  }

  async subscribe(threadId: string): Promise<void> {
    this.ensureConnected();
    logger.debug({ threadId }, 'SQLiteStateAdapter subscribing to thread');

    const stmt = this.db!.prepare(
      `INSERT OR REPLACE INTO chat_sdk_subscriptions (thread_id) VALUES (?)`,
    );
    stmt.run(threadId);
    logger.debug({ threadId }, 'SQLiteStateAdapter subscribed to thread');
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.ensureConnected();
    logger.debug({ threadId }, 'SQLiteStateAdapter unsubscribing from thread');

    const stmt = this.db!.prepare(
      `DELETE FROM chat_sdk_subscriptions WHERE thread_id = ?`,
    );
    const result = stmt.run(threadId);
    logger.debug(
      { threadId, changes: result.changes },
      'SQLiteStateAdapter unsubscribed from thread',
    );
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    this.ensureConnected();

    const stmt = this.db!.prepare(
      `SELECT 1 FROM chat_sdk_subscriptions WHERE thread_id = ?`,
    );
    const result = stmt.get(threadId);
    const isSubscribed = result !== undefined;
    logger.debug(
      { threadId, isSubscribed },
      'SQLiteStateAdapter checking subscription',
    );
    return isSubscribed;
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    this.ensureConnected();
    logger.debug({ threadId, ttlMs }, 'SQLiteStateAdapter acquiring lock');

    // Clean up expired locks first
    this.cleanupExpiredLocks();

    // Check if already locked
    const checkStmt = this.db!.prepare(
      `SELECT token, expires_at, created_at FROM chat_sdk_locks WHERE thread_id = ?`,
    );
    const existing = checkStmt.get(threadId) as
      | { token: string; expires_at: number; created_at: number }
      | undefined;

    if (existing && existing.expires_at > Date.now()) {
      const timeRemaining = existing.expires_at - Date.now();
      const lockAge = Date.now() - existing.created_at;

      logger.debug(
        {
          threadId,
          existingToken: existing.token,
          timeRemainingMs: timeRemaining,
          lockAgeMs: lockAge,
        },
        'SQLiteStateAdapter lock already held',
      );

      // If lock is older than 45 seconds, consider it stuck and force release
      // (normal lock TTL is 30 seconds, so 45s means it should have been released)
      if (lockAge > 45000) {
        logger.warn(
          { threadId, existingToken: existing.token, lockAgeMs: lockAge },
          'SQLiteStateAdapter detected stuck lock (>45s), force releasing',
        );
        this.forceReleaseLock(threadId);
        // Continue to create new lock below
      } else {
        return null; // Lock is valid and not stuck
      }
    }

    // Create new lock with created_at timestamp
    const lock: SQLiteLock = {
      threadId,
      token: generateToken(),
      expiresAt: Date.now() + ttlMs,
    };

    const insertStmt = this.db!.prepare(
      `INSERT OR REPLACE INTO chat_sdk_locks (thread_id, token, expires_at, created_at) VALUES (?, ?, ?, ?)`,
    );
    insertStmt.run(threadId, lock.token, lock.expiresAt, Date.now());

    logger.debug(
      { threadId, token: lock.token, expiresAt: lock.expiresAt },
      'SQLiteStateAdapter lock acquired',
    );
    return lock;
  }

  async releaseLock(lock: Lock): Promise<void> {
    this.ensureConnected();
    logger.debug(
      { threadId: lock.threadId, token: lock.token },
      'SQLiteStateAdapter releasing lock',
    );

    const stmt = this.db!.prepare(
      `DELETE FROM chat_sdk_locks WHERE thread_id = ? AND token = ?`,
    );
    const result = stmt.run(lock.threadId, lock.token);

    if (result.changes === 0) {
      logger.warn(
        { threadId: lock.threadId, token: lock.token },
        'SQLiteStateAdapter lock release had no effect - lock may not exist or token mismatch',
      );
    } else {
      logger.debug(
        { threadId: lock.threadId, token: lock.token, changes: result.changes },
        'SQLiteStateAdapter lock released successfully',
      );
    }
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    this.ensureConnected();
    logger.debug(
      { threadId: lock.threadId, token: lock.token, ttlMs },
      'SQLiteStateAdapter extending lock',
    );

    // Check if lock still exists and matches
    const checkStmt = this.db!.prepare(
      `SELECT expires_at FROM chat_sdk_locks WHERE thread_id = ? AND token = ?`,
    );
    const existing = checkStmt.get(lock.threadId, lock.token) as
      | { expires_at: number }
      | undefined;

    if (!existing) {
      logger.debug(
        { threadId: lock.threadId, token: lock.token },
        'SQLiteStateAdapter lock not found for extension',
      );
      return false; // Lock doesn't exist or token doesn't match
    }

    if (existing.expires_at < Date.now()) {
      // Lock has already expired, clean it up
      logger.debug(
        { threadId: lock.threadId, token: lock.token },
        'SQLiteStateAdapter lock expired, cleaning up',
      );
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

    logger.debug(
      { threadId: lock.threadId, token: lock.token, newExpiresAt },
      'SQLiteStateAdapter lock extended',
    );
    return true;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    this.ensureConnected();
    logger.debug({ key }, 'SQLiteStateAdapter getting cache value');

    const stmt = this.db!.prepare(
      `SELECT value, expires_at FROM chat_sdk_cache WHERE key = ?`,
    );
    const result = stmt.get(key) as
      | { value: string; expires_at: number | null }
      | undefined;

    if (!result) {
      logger.debug({ key }, 'SQLiteStateAdapter cache key not found');
      return null;
    }

    // Check if expired
    if (result.expires_at !== null && result.expires_at <= Date.now()) {
      logger.debug(
        { key, expiresAt: result.expires_at },
        'SQLiteStateAdapter cache key expired, deleting',
      );
      const deleteStmt = this.db!.prepare(
        `DELETE FROM chat_sdk_cache WHERE key = ?`,
      );
      deleteStmt.run(key);
      return null;
    }

    try {
      const parsed = JSON.parse(result.value) as T;
      logger.debug(
        { key, valueType: typeof parsed },
        'SQLiteStateAdapter cache value retrieved',
      );
      return parsed;
    } catch {
      logger.debug(
        { key },
        'SQLiteStateAdapter cache value returned as string',
      );
      return result.value as unknown as T;
    }
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.ensureConnected();
    const serialized = JSON.stringify(value);
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;

    logger.debug(
      { key, hasTtl: !!ttlMs, expiresAt, valueLength: serialized.length },
      'SQLiteStateAdapter setting cache value',
    );

    const stmt = this.db!.prepare(
      `INSERT OR REPLACE INTO chat_sdk_cache (key, value, expires_at) VALUES (?, ?, ?)`,
    );
    stmt.run(key, serialized, expiresAt);
    logger.debug({ key }, 'SQLiteStateAdapter cache value set');
  }

  async delete(key: string): Promise<void> {
    this.ensureConnected();
    logger.debug({ key }, 'SQLiteStateAdapter deleting cache value');

    const stmt = this.db!.prepare(`DELETE FROM chat_sdk_cache WHERE key = ?`);
    const result = stmt.run(key);
    logger.debug(
      { key, changes: result.changes },
      'SQLiteStateAdapter cache value deleted',
    );
  }

  private ensureConnected(): void {
    if (!this.connected || !this.db) {
      logger.error(
        { connected: this.connected, hasDb: !!this.db },
        'SQLiteStateAdapter operation attempted while not connected',
      );
      throw new Error(
        'SQLiteStateAdapter is not connected. Call connect() first.',
      );
    }
  }

  private cleanupExpiredLocks(): void {
    const stmt = this.db!.prepare(
      `DELETE FROM chat_sdk_locks WHERE expires_at <= ?`,
    );
    const result = stmt.run(Date.now());
    if (result.changes > 0) {
      logger.debug(
        { deletedLocks: result.changes },
        'SQLiteStateAdapter cleaned up expired locks',
      );
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();

    // Clean expired locks
    const lockStmt = this.db!.prepare(
      `DELETE FROM chat_sdk_locks WHERE expires_at <= ?`,
    );
    const lockResult = lockStmt.run(now);

    // Clean expired cache entries
    const cacheStmt = this.db!.prepare(
      `DELETE FROM chat_sdk_cache WHERE expires_at IS NOT NULL AND expires_at <= ?`,
    );
    const cacheResult = cacheStmt.run(now);

    if (lockResult.changes > 0 || cacheResult.changes > 0) {
      logger.debug(
        { deletedLocks: lockResult.changes, deletedCache: cacheResult.changes },
        'SQLiteStateAdapter cleaned up expired items',
      );
    }
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

  /**
   * Force release a lock by threadId only (no token check).
   * Use this only for cleanup of stuck locks.
   */
  forceReleaseLock(threadId: string): boolean {
    this.ensureConnected();
    logger.warn(
      { threadId },
      'SQLiteStateAdapter force releasing lock (no token check)',
    );

    const stmt = this.db!.prepare(
      `DELETE FROM chat_sdk_locks WHERE thread_id = ?`,
    );
    const result = stmt.run(threadId);

    if (result.changes > 0) {
      logger.info(
        { threadId, deletedLocks: result.changes },
        'SQLiteStateAdapter force released lock',
      );
      return true;
    }
    return false;
  }
}

function generateToken(): string {
  return `sqlite_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

export function createSQLiteState(dbPath?: string): SQLiteStateAdapter {
  return new SQLiteStateAdapter(dbPath);
}
