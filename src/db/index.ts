// Main database exports
export { db } from './main/client';
export * as schema from './main/schema';

// Session schema is now in main DB - kept for backward compatibility during migration
export * as sessionSchema from './sessions/schema';
