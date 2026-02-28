import { drizzle } from 'drizzle-orm/libsql/node';
import fs from 'fs';
import path from 'path';
import { STORE_DIR } from '../../config.js';
import * as schema from './schema.js';
import { createClient } from '@libsql/client/node';

export let db: ReturnType<typeof drizzle<typeof schema>>;

const dbPath = path.join(STORE_DIR, 'main.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const sqlite = createClient({ url: 'file:' + dbPath });
db = drizzle(sqlite, { schema });
