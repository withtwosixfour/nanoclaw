import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'DISCORD_BOT_TOKEN',
  'DISCORD_ONLY',
  'ADMIN_USER_IDS',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

const PROJECT_ROOT = process.cwd();
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const AGENTS_DIR = path.resolve(PROJECT_ROOT, 'agents');
export const SESSIONS_DIR = path.resolve(PROJECT_ROOT, 'sessions');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_AGENT_ID = 'main';

export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep agent run alive after last result
export const MAX_CONCURRENT_RUNS = Math.max(
  1,
  parseInt(
    process.env.MAX_CONCURRENT_RUNS ||
      process.env.MAX_CONCURRENT_CONTAINERS ||
      '5',
    10,
  ) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

export const DISCORD_BOT_TOKEN =
  process.env.DISCORD_BOT_TOKEN || envConfig.DISCORD_BOT_TOKEN || '';
export const DISCORD_ONLY =
  (process.env.DISCORD_ONLY || envConfig.DISCORD_ONLY) === 'true';

// Comma-separated list of authorized user IDs who can trigger /update command
// Format: 1234567890@s.whatsapp.net,discord:123456789012345678
export const ADMIN_USER_IDS = (
  process.env.ADMIN_USER_IDS ||
  envConfig.ADMIN_USER_IDS ||
  ''
)
  .split(',')
  .map((id) => id.trim())
  .filter((id) => id.length > 0);
