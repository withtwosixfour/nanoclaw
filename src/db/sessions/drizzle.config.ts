/** @type {import('drizzle-kit').Config} */
export default {
  dialect: 'sqlite',
  out: '../../../drizzle/sessions',
  schema: './schema.ts',
  dbCredentials: {
    url: ':memory:', // Template - actual DBs are created per-JID
  },
};
