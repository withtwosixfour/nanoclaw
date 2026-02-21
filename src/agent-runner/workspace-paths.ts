import path from 'path';

export interface WorkspaceContext {
  groupDir: string;
  projectDir: string;
  globalDir: string;
  isMain: boolean;
}

export interface ResolveOptions {
  defaultCwd?: string;
  allowProject?: boolean;
  allowGlobal?: boolean;
}

export function resolveWorkspacePath(
  inputPath: string,
  ctx: WorkspaceContext,
  options: ResolveOptions = {},
): { resolvedPath?: string; error?: string } {
  const allowProject = options.allowProject ?? ctx.isMain;
  const allowGlobal = options.allowGlobal ?? !ctx.isMain;
  const defaultCwd = options.defaultCwd || ctx.groupDir;
  let mappedPath = inputPath;

  if (inputPath.startsWith('/workspace/project')) {
    if (!allowProject) {
      return { error: 'Project workspace access is restricted.' };
    }
    mappedPath = path.join(
      ctx.projectDir,
      inputPath.slice('/workspace/project'.length),
    );
  } else if (inputPath.startsWith('/workspace/group')) {
    mappedPath = path.join(
      ctx.groupDir,
      inputPath.slice('/workspace/group'.length),
    );
  } else if (inputPath.startsWith('/workspace/global')) {
    if (!allowGlobal) {
      return { error: 'Global workspace access is restricted.' };
    }
    mappedPath = path.join(
      ctx.globalDir,
      inputPath.slice('/workspace/global'.length),
    );
  } else if (inputPath.startsWith('/workspace/extra')) {
    return { error: 'Extra workspace mounts are not available.' };
  } else if (!path.isAbsolute(inputPath)) {
    mappedPath = path.join(defaultCwd, inputPath);
  }

  const resolved = path.resolve(mappedPath);
  const allowedRoots = [path.resolve(ctx.groupDir)];

  if (allowProject && ctx.isMain) {
    allowedRoots.push(path.resolve(ctx.projectDir));
  }
  if (allowGlobal) {
    allowedRoots.push(path.resolve(ctx.globalDir));
  }

  const isAllowed = allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
  );

  if (!isAllowed) {
    return { error: 'Path is outside allowed workspace roots.' };
  }

  return { resolvedPath: resolved };
}
