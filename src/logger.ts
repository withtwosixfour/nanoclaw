import pino from 'pino';
import fs from 'fs';
import path from 'path';

// Ensure logs directory exists
const logsDir = 'logs';
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Disable colors in logs when running non-interactively or when NO_COLOR is set
const useColors = process.stdout.isTTY && !process.env.NO_COLOR;

const level = process.env.LOG_LEVEL || 'info';

export const logger = pino({
  level,
  transport: {
    targets: [
      {
        target: 'pino-pretty',
        level,
        options: {
          colorize: useColors,
          translateTime: 'yyyy-mm-dd HH:MM:ss.l',
          ignore: 'pid,hostname',
          messageFormat: '{msg}',
          singleLine: true,
        },
      },
      {
        target: 'pino/file',
        level,
        options: {
          destination: path.join(logsDir, 'nanoclaw.log'),
          mkdir: true,
        },
      },
    ],
  },
});

logger.info({ level }, 'logger initialized');

// Route uncaught errors through pino so they get timestamps
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
