import { readEnvFile, requireEnvValue } from './env.js';
import { setupLogger } from './logger.js';
import { SlackSetupFlow } from './providers/slack.js';
import { SetupServer, writeHtml } from './server.js';
import { discoverPublicIpv4, ensureIpCertificate } from './tls.js';

function usage(): never {
  console.error(
    'Usage: tsx scripts/setup-server/index.ts slack --env-file <path> [--timeout-seconds <seconds>]',
  );
  process.exit(1);
}

const args = process.argv.slice(2);
if (args[0] !== 'slack') {
  usage();
}

const envFileIndex = args.indexOf('--env-file');
if (envFileIndex === -1 || !args[envFileIndex + 1]) {
  usage();
}

const timeoutIndex = args.indexOf('--timeout-seconds');
const timeoutSeconds =
  timeoutIndex === -1
    ? 1800
    : Number.parseInt(args[timeoutIndex + 1] ?? '', 10);

if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  throw new Error('Invalid --timeout-seconds value');
}

const envFile = args[envFileIndex + 1];

if (typeof process.getuid === 'function' && process.getuid() !== 0) {
  throw new Error(
    'Setup server must run as root so Certbot can bind port 80 and HTTPS can bind port 443.',
  );
}

const env = await readEnvFile(envFile);
const clientId = requireEnvValue(env, 'SLACK_CLIENT_ID');
const clientSecret = requireEnvValue(env, 'SLACK_CLIENT_SECRET');
requireEnvValue(env, 'SLACK_APP_TOKEN');

const publicIp = await discoverPublicIpv4();
const tls = await ensureIpCertificate(publicIp);
const redirectUri = `https://${publicIp}/setup/slack/callback`;

const slackFlow = new SlackSetupFlow({
  env,
  clientId,
  clientSecret,
  redirectUri,
});

const server = new SetupServer(tls, publicIp);
server.register('/healthz', (_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: true }));
});
server.register(slackFlow.callbackPath, async (_request, response, url) => {
  const result = await slackFlow.handleCallback(url);
  writeHtml(response, result.statusCode, result.title, result.body);
});

await server.start();

setupLogger.info(
  { redirectUri, authorizeUrl: slackFlow.authorizeUrl },
  'Slack setup server ready',
);
console.log(`Slack redirect URL: ${redirectUri}`);
console.log(`Slack authorize URL: ${slackFlow.authorizeUrl}`);

const timeout = setTimeout(() => {
  slackFlow.fail(
    new Error(`Timed out waiting ${timeoutSeconds}s for Slack OAuth callback`),
  );
}, timeoutSeconds * 1000);

try {
  await slackFlow.completion;
  clearTimeout(timeout);
} finally {
  clearTimeout(timeout);
  await server.stop();
}
