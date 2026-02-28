import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { AGENTS_DIR, SESSIONS_DIR, STORE_DIR } from './config.js';
import { logger } from './logger.js';
import {
  getRouterState,
  setRouterState,
  setSession,
  setRoute,
  setAgent,
} from './db.js';

/**
 * Migration: groups/ -> agents/ + sessions/
 *
 * 1. Queries old registered_groups table to get JID -> folder mappings
 * 2. Renames groups/ to agents/
 * 3. Moves agents/{folder}/.nanoclaw/* to sessions/{jid}/*
 * 4. Adds routes to the database
 * 5. Migrates legacy sessions from router_state
 */
export async function runMigration(): Promise<void> {
  const migrationKey = 'migration_v2_complete';

  // Check if migration already ran
  if ((await getRouterState(migrationKey)) === 'true') {
    logger.debug('Migration v2 already completed');
    return;
  }

  const groupsDir = path.join(process.cwd(), 'groups');
  const agentsDir = AGENTS_DIR;
  const sessionsDir = SESSIONS_DIR;

  // Check if old groups directory exists
  if (!fs.existsSync(groupsDir)) {
    logger.debug('No groups directory to migrate');
    setRouterState(migrationKey, 'true');
    return;
  }

  logger.info('Starting migration: groups/ -> agents/ + sessions/');

  // Query old registered_groups table to get JID mappings
  // This must happen before the DB schema migration
  const jidToFolderMap = new Map<string, string>();
  const folderToJidMap = new Map<string, string[]>();

  try {
    const dbPath = path.join(STORE_DIR, 'messages.db');
    if (fs.existsSync(dbPath)) {
      const db = new Database(dbPath);
      const tableInfo = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='registered_groups'",
        )
        .get() as { name: string } | undefined;

      if (tableInfo) {
        const rows = db
          .prepare('SELECT jid, folder FROM registered_groups')
          .all() as Array<{ jid: string; folder: string }>;

        for (const row of rows) {
          jidToFolderMap.set(row.jid, row.folder);
          const existing = folderToJidMap.get(row.folder) || [];
          existing.push(row.jid);
          folderToJidMap.set(row.folder, existing);
        }

        logger.info(
          { count: rows.length },
          'Loaded JID mappings from registered_groups table',
        );
      }
      db.close();
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to query old registered_groups table');
  }

  // Also check for legacy registered_groups.json
  const dataDir = path.join(process.cwd(), 'data');
  const legacyGroupsJson = path.join(dataDir, 'registered_groups.json');
  if (fs.existsSync(legacyGroupsJson)) {
    try {
      const groups = JSON.parse(
        fs.readFileSync(legacyGroupsJson, 'utf-8'),
      ) as Record<string, { folder: string }>;
      for (const [jid, group] of Object.entries(groups)) {
        if (!jidToFolderMap.has(jid)) {
          jidToFolderMap.set(jid, group.folder);
          const existing = folderToJidMap.get(group.folder) || [];
          existing.push(jid);
          folderToJidMap.set(group.folder, existing);
        }
      }
      logger.info(
        { count: Object.keys(groups).length },
        'Loaded JID mappings from registered_groups.json',
      );
    } catch (err) {
      logger.warn({ err }, 'Failed to parse registered_groups.json');
    }
  }

  // Load legacy sessions from router_state if available
  const legacySessions = new Map<string, string>(); // folder -> sessionId
  const legacySessionsJson = await getRouterState('legacy_sessions');
  if (legacySessionsJson) {
    try {
      const sessions = JSON.parse(legacySessionsJson) as Record<string, string>;
      for (const [folder, sessionId] of Object.entries(sessions)) {
        legacySessions.set(folder, sessionId);
      }
      logger.info(
        { count: legacySessions.size },
        'Loaded legacy sessions from router_state',
      );
    } catch (err) {
      logger.warn({ err }, 'Failed to parse legacy_sessions');
    }
  }

  // Create new directories
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });

  // Get list of group folders
  const entries = fs.readdirSync(groupsDir, { withFileTypes: true });
  const routesToAdd: Array<{ jid: string; agentId: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const folderName = entry.name;
    const oldGroupPath = path.join(groupsDir, folderName);
    const newAgentPath = path.join(agentsDir, folderName);
    const nanoclawPath = path.join(oldGroupPath, '.nanoclaw');

    // Check if this folder has .nanoclaw (was a registered group)
    if (fs.existsSync(nanoclawPath)) {
      logger.info({ folder: folderName }, 'Migrating registered group');

      // Get JIDs for this folder from the mapping
      const jids = folderToJidMap.get(folderName) || [];

      if (jids.length === 0) {
        // No JID mapping found - use placeholder
        jids.push(`legacy:${folderName}`);
        logger.warn(
          { folder: folderName },
          'No JID mapping found for folder, using placeholder',
        );
      }

      // Read session.json for sessionId
      const sessionJsonPath = path.join(nanoclawPath, 'session.json');
      let sessionId = legacySessions.get(folderName);

      if (fs.existsSync(sessionJsonPath)) {
        try {
          const sessionData = JSON.parse(
            fs.readFileSync(sessionJsonPath, 'utf-8'),
          ) as { sessionId?: string };
          if (sessionData.sessionId) {
            sessionId = sessionData.sessionId;
          }
        } catch (err) {
          logger.warn(
            { folder: folderName, err },
            'Failed to read session.json',
          );
        }
      }

      // Migrate each JID
      for (const jid of jids) {
        const sanitizedJid = jid.replace(/[:@]/g, '_');
        const newSessionPath = path.join(sessionsDir, sanitizedJid);
        fs.mkdirSync(newSessionPath, { recursive: true });

        // Move conversation.db
        const oldDbPath = path.join(nanoclawPath, 'conversation.db');
        if (fs.existsSync(oldDbPath)) {
          fs.copyFileSync(
            oldDbPath,
            path.join(newSessionPath, 'conversation.db'),
          );
        }

        // Create session.json with new format
        if (sessionId) {
          fs.writeFileSync(
            path.join(newSessionPath, 'session.json'),
            JSON.stringify({ sessionId, agentId: folderName, jid }, null, 2),
          );

          // Save to DB as well
          setSession(jid, folderName, sessionId);
        }

        // Add to routes (DB)
        setRoute(jid, folderName);
        routesToAdd.push({ jid, agentId: folderName });
        logger.info({ folder: folderName, jid }, 'Migrated session');
      }

      // Create agent entry in DB for this folder
      // Check if we have metadata from registered_groups
      const agentJid = jids[0];
      const existingGroup = agentJid ? jidToFolderMap.get(agentJid) : undefined;

      // Create agent with defaults
      const agent = {
        id: folderName,
        folder: folderName,
        name: folderName,
        trigger: `@${folderName}`,
        added_at: new Date().toISOString(),
        requiresTrigger: folderName !== 'main', // main doesn't require trigger
        modelProvider: 'opencode-zen',
        modelName: 'kimi-k2.5',
        isMain: folderName === 'main',
      };

      setAgent(folderName, agent);
      logger.info({ folder: folderName }, 'Created agent in database');

      // Remove .nanoclaw directory
      try {
        fs.rmSync(nanoclawPath, { recursive: true, force: true });
      } catch {
        // Ignore errors
      }
    }

    // Copy/move rest of agent files (CLAUDE.md, logs/, etc.)
    const agentFiles = fs.readdirSync(oldGroupPath);
    fs.mkdirSync(newAgentPath, { recursive: true });

    for (const file of agentFiles) {
      if (file === '.nanoclaw') continue; // Already handled

      const oldFilePath = path.join(oldGroupPath, file);
      const newFilePath = path.join(newAgentPath, file);

      try {
        if (fs.statSync(oldFilePath).isDirectory()) {
          // Recursively copy directory
          copyDirRecursive(oldFilePath, newFilePath);
        } else {
          fs.copyFileSync(oldFilePath, newFilePath);
        }
      } catch (err) {
        logger.warn({ file, err }, 'Failed to copy file during migration');
      }
    }

    logger.info({ folder: folderName }, 'Migrated agent folder');
  }

  // Rename groups/ to groups_backup/ (don't delete for safety)
  const backupDir = path.join(process.cwd(), 'groups_backup');
  try {
    fs.renameSync(groupsDir, backupDir);
    logger.info('Renamed groups/ to groups_backup/');
  } catch (err) {
    logger.error({ err }, 'Failed to rename groups directory');
  }

  // Log routes that need to be configured
  if (routesToAdd.length > 0) {
    logger.info('');
    logger.info('='.repeat(60));
    logger.info('MIGRATION COMPLETE');
    logger.info('='.repeat(60));
    logger.info('');
    logger.info(`Migrated ${routesToAdd.length} JID(s) to agents:`);
    logger.info('');
    for (const { jid, agentId } of routesToAdd) {
      if (jid.startsWith('legacy:')) {
        logger.warn(`  ${jid} -> ${agentId} (PLACEHOLDER - needs actual JID)`);
      } else {
        logger.info(`  ${jid} -> ${agentId} (automatically routed)`);
      }
    }
    logger.info('');

    const placeholderCount = routesToAdd.filter((r) =>
      r.jid.startsWith('legacy:'),
    ).length;
    if (placeholderCount > 0) {
      logger.warn(
        `${placeholderCount} placeholder route(s) need manual JID updates.`,
      );
      logger.info(
        'Add routes with add_route to replace legacy: routes with actual JIDs:',
      );
      logger.info('  - Discord: dc:{channelId}');
      logger.info('  - WhatsApp groups: {groupId}@g.us');
      logger.info('  - WhatsApp DMs: {phone}@s.whatsapp.net');
    }

    logger.info('');
    logger.info(
      'The old groups directory has been backed up to groups_backup/',
    );
    logger.info('='.repeat(60));
  }

  // Clean up legacy_sessions from router_state
  try {
    setRouterState('legacy_sessions', '');
  } catch {
    // Ignore cleanup errors
  }

  setRouterState(migrationKey, 'true');
  logger.info('Migration v2 complete');
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
