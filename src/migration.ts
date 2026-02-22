import fs from 'fs';
import path from 'path';
import { AGENTS_DIR, SESSIONS_DIR, DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { addRoute } from './router.js';
import { getRouterState, setRouterState } from './db.js';

/**
 * Migration: groups/ -> agents/ + sessions/
 *
 * 1. Renames groups/ to agents/
 * 2. Moves agents/{folder}/.nanoclaw/* to sessions/{jid}/*
 * 3. Logs routes that need to be added to ROUTES
 */
export async function runMigration(): Promise<void> {
  const migrationKey = 'migration_v2_complete';

  // Check if migration already ran
  if (getRouterState(migrationKey) === 'true') {
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

      // Read session.json to get the JID
      const sessionJsonPath = path.join(nanoclawPath, 'session.json');
      let jid = '';

      if (fs.existsSync(sessionJsonPath)) {
        try {
          const sessionData = JSON.parse(
            fs.readFileSync(sessionJsonPath, 'utf-8'),
          );
          // Try to determine JID from old data structure
          // Old format: { sessionId, groupFolder }
          // We need to infer JID from legacy data or use folder name as placeholder

          // For now, create session based on folder name
          // This will need manual update of ROUTES
          jid = `legacy:${folderName}`;

          // Move session files to new location
          const sanitizedJid = jid.replace(/[:@]/g, '_');
          const newSessionPath = path.join(sessionsDir, sanitizedJid);
          fs.mkdirSync(newSessionPath, { recursive: true });

          // Move conversation.db
          const oldDbPath = path.join(nanoclawPath, 'conversation.db');
          if (fs.existsSync(oldDbPath)) {
            fs.renameSync(
              oldDbPath,
              path.join(newSessionPath, 'conversation.db'),
            );
          }

          // Move session.json
          fs.renameSync(
            sessionJsonPath,
            path.join(newSessionPath, 'session.json'),
          );

          routesToAdd.push({ jid, agentId: folderName });
          logger.info({ folder: folderName, jid }, 'Migrated session');
        } catch (err) {
          logger.warn({ folder: folderName, err }, 'Failed to migrate session');
        }
      }

      // Remove .nanoclaw directory
      try {
        fs.rmSync(nanoclawPath, { recursive: true, force: true });
      } catch {
        // Ignore errors
      }
    }

    // Copy/move rest of agent files (CLAUDE.md, logs/, etc.)
    // Use copy first, then remove old to preserve any new files
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
    logger.info('MIGRATION COMPLETE - ACTION REQUIRED');
    logger.info('='.repeat(60));
    logger.info('');
    logger.info('Update src/router.ts to add these routes:');
    logger.info('');
    for (const { jid, agentId } of routesToAdd) {
      logger.info(`  '${jid}': '${agentId}',`);
    }
    logger.info('');
    logger.info('You need to replace "legacy:{folder}" with actual JIDs:');
    logger.info('  - Discord: dc:{channelId}');
    logger.info('  - WhatsApp groups: {groupId}@g.us');
    logger.info('  - WhatsApp DMs: {phone}@s.whatsapp.net');
    logger.info('');
    logger.info(
      'The old groups directory has been backed up to groups_backup/',
    );
    logger.info('='.repeat(60));
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
