/** @type {import('drizzle-kit').Config} */
export default {
  dialect: 'sqlite',
  out: '../../../drizzle/main',
  schema: './schema.ts',
  dbCredentials: {
    url: '../../../store/main.db',
  },
};
