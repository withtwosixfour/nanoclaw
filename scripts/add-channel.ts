import { setRoute, getAgent, setAgent } from '../src/db.js';
import { logger } from '../src/logger.js';

const args = process.argv.slice(2);

if (args.length < 1) {
  console.error('Usage: npm run add-channel <thread-id> [agent-name]');
  console.error('  thread-id: e.g., discord:guild-id:channel-id:thread-id');
  console.error('  agent-name: Optional agent name (defaults to "main")');
  console.error('');
  console.error('Examples:');
  console.error('  npm run add-channel discord:123456789:987654321:456789123');
  console.error(
    '  npm run add-channel discord:123456789:987654321:456789123 my-custom-agent',
  );
  process.exit(1);
}

const threadId = args[0];
const agentName = args[1] || 'main';

// Get or create the agent
let agent = await getAgent(agentName);
if (!agent) {
  if (agentName === 'main') {
    // Create default main agent
    logger.info(`Creating default "main" agent...`);
    setAgent('main', {
      id: 'main',
      folder: 'main',
      name: 'Main Agent',
      trigger: '@nanoclaw',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      modelProvider: 'opencode-zen',
      modelName: 'kimi-k2.5',
      isMain: true,
    });
    agent = await getAgent('main');
    logger.info('Default "main" agent created');
  } else {
    logger.error(`Agent "${agentName}" not found. Please create it first.`);
    process.exit(1);
  }
}

// Add the route
setRoute(threadId, agentName);

logger.info(`✅ Successfully added channel: ${threadId}`);
logger.info(`   Agent: ${agent?.name || agentName} (${agentName})`);
logger.info(`   The agent will now respond to messages in this channel`);
