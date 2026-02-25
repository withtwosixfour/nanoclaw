import path from 'path';
import { config } from 'dotenv';
import { logger } from './logger.js';

/**
 * Load the .env file into process.env and return values for the requested keys.
 * Only loads keys that are not already set in process.env (respects existing env).
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');

  // Load .env into process.env (but don't override existing values)
  config({ path: envFile, override: false });

  const result: Record<string, string> = {};

  for (const key of keys) {
    const value = process.env[key];
    if (value) {
      logger.debug({ key }, 'found env value');
      result[key] = value;
    }
  }

  return result;
}
