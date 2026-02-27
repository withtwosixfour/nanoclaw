import { drizzle } from 'drizzle-orm/libsql/node';
import fs from 'fs';
import path from 'path';
import { STORE_DIR } from '../../config.js';
import * as schema from './schema.js';
import { createClient } from '@libsql/client';

export let db: ReturnType<typeof drizzle<typeof schema>>;

export function initMainDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'main.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const sqlite = createClient({ url: 'libsql://' + dbPath });
  db = drizzle(sqlite, { schema });
}
