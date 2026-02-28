import { createBashTool } from './tools/bash.js';
import { createFsTools } from './tools/fs.js';
import { createWebTools } from './tools/web.js';
import {
  createNanoClawTools,
  NanoClawContext,
  NanoClawDeps,
} from './tools/nanoclaw.js';
import { SendAttachment } from './tools/send-attachment.js';
import { WorkspaceContext } from './workspace-paths.js';
import { wrapToolRegistryWithTruncation } from './tool-wrapper.js';

export function createBaseTools(options: {
  workspace: WorkspaceContext;
  nanoclawContext: NanoClawContext;
  nanoclawDeps: NanoClawDeps;
}) {
  return {
    Bash: createBashTool(options.workspace),
    ...createFsTools(options.workspace),
    ...createWebTools(),
    ...createNanoClawTools(options.nanoclawDeps, options.nanoclawContext),
    SendAttachment,
  };
}

export function createToolRegistry(options: {
  workspace: WorkspaceContext;
  nanoclawContext: NanoClawContext;
  nanoclawDeps: NanoClawDeps;
}) {
  const tools = createBaseTools(options);

  return wrapToolRegistryWithTruncation(tools);
}
