import pino from 'pino';
import fs from 'fs';
import path from 'path';

// Set OTEL env vars for PostHog BEFORE any imports that might read them
// This ensures pino-opentelemetry-transport gets the right config in its worker thread
// We only set them if not already configured to respect user overrides
if (process.env.POSTHOG_API_KEY) {
  if (!process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) {
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = `${process.env.POSTHOG_HOST}/i/v1/logs`;
  }
  if (!process.env.OTEL_EXPORTER_OTLP_HEADERS) {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = `Authorization=Bearer ${process.env.POSTHOG_API_KEY}`;
  }
  if (!process.env.OTEL_RESOURCE_ATTRIBUTES) {
    process.env.OTEL_RESOURCE_ATTRIBUTES = `service.name=nanoclaw,service.version=${process.env.npm_package_version || '1.0.0'}`;
  }
}

// Ensure logs directory exists
const logsDir = 'logs';
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Detect dev mode - dev script sets LOG_LEVEL=debug
const isDevMode =
  process.env.LOG_LEVEL === 'debug' || process.env.NODE_ENV === 'development';

// Disable colors in logs when running non-interactively or when NO_COLOR is set
const useColors = process.stdout.isTTY && !process.env.NO_COLOR;

const level = process.env.LOG_LEVEL || 'info';

// Build transport targets based on environment
const transportTargets: pino.TransportTargetOptions[] = [];

if (isDevMode) {
  // In dev mode: console pretty print + file logging
  transportTargets.push(
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
  );
} else if (process.env.POSTHOG_API_KEY) {
  // In production with PostHog: send logs to PostHog via OpenTelemetry
  transportTargets.push({
    target: 'pino-opentelemetry-transport',
    level,
    options: {
      loggerName: 'nanoclaw',
      serviceVersion: process.env.npm_package_version || '1.0.0',
      resourceAttributes: {
        'service.name': 'nanoclaw',
        'service.version': process.env.npm_package_version || '1.0.0',
      },
    },
  });
} else {
  // In production without PostHog: file logging only
  transportTargets.push({
    target: 'pino/file',
    level,
    options: {
      destination: path.join(logsDir, 'nanoclaw.log'),
      mkdir: true,
    },
  });
}

export const logger = pino({
  level,
  transport: {
    targets: transportTargets,
  },
});

logger.info(
  {
    level,
    isDevMode,
    posthogEnabled: process.env.POSTHOG_API_KEY != undefined,
  },
  'logger initialized',
);

// Route uncaught errors through pino so they get timestamps
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
