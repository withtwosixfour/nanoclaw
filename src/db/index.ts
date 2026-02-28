// Main database exports
export { db } from './main/client';
export * as schema from './main/schema';

// Session database exports
export {
  getSessionDb,
  closeSessionDb,
  closeAllSessionDbs,
} from './sessions/client';
export * as sessionSchema from './sessions/schema';
