import { createBashTool } from './tools/bash.js';
import { createFsTools } from './tools/fs.js';
import { createWebTools } from './tools/web.js';
import {
  createNanoClawTools,
  NanoClawContext,
  NanoClawDeps,
} from './tools/nanoclaw.js';
import { SendImage } from './tools/send-image.js';
import { WorkspaceContext } from './workspace-paths.js';

export function createToolRegistry(options: {
  workspace: WorkspaceContext;
  nanoclawContext: NanoClawContext;
  nanoclawDeps: NanoClawDeps;
}): Record<string, unknown> {
  return {
    Bash: createBashTool(options.workspace),
    ...createFsTools(options.workspace),
    ...createWebTools(),
    ...createNanoClawTools(options.nanoclawDeps, options.nanoclawContext),
    SendImage,
  };
}
