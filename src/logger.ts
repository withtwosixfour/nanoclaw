import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { getInstanceInfo } from './instance.js';

// Load instance info early (before logger setup)
const instanceInfo = getInstanceInfo();

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
    process.env.OTEL_RESOURCE_ATTRIBUTES = `service.name=nanoclaw,service.version=${process.env.npm_package_version || '1.0.0'},service.instance.id=${instanceInfo.id},service.instance.name=${instanceInfo.name}`;
  }
}

// Ensure logs directory exists
const logsDir = 'logs';
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const isDevMode =
  process.env.LOG_LEVEL === 'debug' || process.env.NODE_ENV === 'development';

if (isDevMode) {
  // warn will appear in the file/console transport that IS active
  console.warn(
    '[logger] LOG_LEVEL=debug: PostHog transport is disabled in dev mode',
  );
}

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
        'service.instance.id': instanceInfo.id,
        'service.instance.name': instanceInfo.name,
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
  base: {
    instanceId: instanceInfo.id,
    instanceName: instanceInfo.name,
  },
  transport: {
    targets: transportTargets,
  },
});

logger.info(
  {
    level,
    isDevMode,
    posthogEnabled: !!process.env.POSTHOG_API_KEY,
    instanceId: instanceInfo.id,
    instanceName: instanceInfo.name,
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
