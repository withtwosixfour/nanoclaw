import { createBashTool } from './bash.js';
import { createFsTools } from './fs.js';
import { createWebTools } from './web.js';
import { createMcpTools } from './mcp.js';

export function createToolRegistry(options: {
  mcpServerPath: string;
  mcpEnv: Record<string, string | undefined>;
}): Record<string, unknown> {
  return {
    Bash: createBashTool(),
    ...createFsTools(),
    ...createWebTools(),
    ...createMcpTools({
      mcpServerPath: options.mcpServerPath,
      env: options.mcpEnv,
    }),
  };
}
