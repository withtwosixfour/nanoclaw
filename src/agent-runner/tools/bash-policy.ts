import fs from 'fs';
import path from 'path';
import { z } from 'zod';

const POLICY_RELATIVE_PATH = path.join('.nanoclaw', 'bash-policy.json');

const argRuleSchema = z
  .object({
    denyFlags: z.array(z.string()).optional(),
    denyPatterns: z.array(z.string()).optional(),
    allowFlags: z.array(z.string()).optional(),
  })
  .strict();

const bashPolicySchema = z
  .object({
    enabled: z.boolean().optional().default(true),
    mode: z.enum(['blacklist', 'whitelist']),
    commands: z
      .object({
        blacklist: z.array(z.string()).optional(),
        whitelist: z.array(z.string()).optional(),
      })
      .strict(),
    args: z.record(z.string(), argRuleSchema).optional(),
    shell: z
      .object({
        denyBuiltins: z.array(z.string()).optional(),
        denyOperators: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    audit: z
      .object({
        logAllowed: z.boolean().optional(),
        logDenied: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type BashPolicyConfig = z.infer<typeof bashPolicySchema>;

interface ArgRule {
  denyFlags: string[];
  allowFlags: string[];
  denyPatterns: RegExp[];
}

type ArgRuleConfig = z.infer<typeof argRuleSchema>;

export interface BashPolicy {
  sourcePath: string;
  enabled: boolean;
  mode: 'blacklist' | 'whitelist';
  commandBlacklist: Set<string>;
  commandWhitelist: Set<string>;
  denyBuiltins: Set<string>;
  denyOperators: Set<string>;
  args: Map<string, ArgRule>;
}

interface PolicyCacheEntry {
  mtimeMs: number;
  policy: BashPolicy;
}

export type BashPolicyLoadResult =
  | { ok: true; found: false }
  | { ok: true; found: true; policy: BashPolicy }
  | { ok: false; error: string };

export type BashPolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

const policyCache = new Map<string, PolicyCacheEntry>();

export interface ParsedCommand {
  raw: string;
  command: string;
  args: string[];
}

function normalizeCommandName(input: string): string {
  return path.basename(input).toLowerCase();
}

function tokenizeCommand(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaping = false;

  for (let i = 0; i < segment.length; i++) {
    const char = segment[i];

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\' && !inSingle) {
      escaping = true;
      continue;
    }

    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (!inSingle && !inDouble && /\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function splitSimpleCommands(command: string): string[] {
  const commands: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaping = false;
  let subshellDepth = 0;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const next = command[i + 1] || '';

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\' && !inSingle) {
      current += char;
      escaping = true;
      continue;
    }

    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      current += char;
      continue;
    }

    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      current += char;
      continue;
    }

    if (!inSingle && !inDouble) {
      if (char === '$' && next === '(') {
        subshellDepth += 1;
      } else if (char === ')' && subshellDepth > 0) {
        subshellDepth -= 1;
      }

      if (subshellDepth === 0) {
        const two = `${char}${next}`;
        if (two === '&&' || two === '||') {
          if (current.trim()) {
            commands.push(current.trim());
          }
          current = '';
          i += 1;
          continue;
        }

        if (char === ';' || char === '|' || char === '&' || char === '\n') {
          if (current.trim()) {
            commands.push(current.trim());
          }
          current = '';
          continue;
        }
      }
    }

    current += char;
  }

  if (current.trim()) {
    commands.push(current.trim());
  }

  return commands;
}

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*/;

export function parseCommandSegments(command: string): ParsedCommand[] {
  const segments = splitSimpleCommands(command);
  const parsed: ParsedCommand[] = [];

  for (const segment of segments) {
    const tokens = tokenizeCommand(segment);
    if (tokens.length === 0) {
      continue;
    }

    let i = 0;
    while (i < tokens.length && ENV_ASSIGNMENT_RE.test(tokens[i])) {
      i += 1;
    }

    if (i >= tokens.length) {
      continue;
    }

    if (tokens[i] === 'env') {
      i += 1;
      while (i < tokens.length && ENV_ASSIGNMENT_RE.test(tokens[i])) {
        i += 1;
      }
      if (i >= tokens.length) {
        continue;
      }
    }

    let commandName = tokens[i];
    if (commandName === 'command' || commandName === 'builtin') {
      i += 1;
      if (i >= tokens.length) {
        continue;
      }
      commandName = tokens[i];
    }

    parsed.push({
      raw: segment,
      command: normalizeCommandName(commandName),
      args: tokens.slice(i + 1),
    });
  }

  return parsed;
}

function compileArgRule(command: string, rule: ArgRuleConfig): ArgRule {
  const denyPatterns = (rule.denyPatterns || []).map((pattern: string) => {
    try {
      return new RegExp(pattern);
    } catch {
      throw new Error(
        `Invalid deny pattern for command "${command}": ${pattern}`,
      );
    }
  });

  return {
    denyFlags: (rule.denyFlags || [])
      .map((flag: string) => flag.trim())
      .filter(Boolean),
    allowFlags: (rule.allowFlags || [])
      .map((flag: string) => flag.trim())
      .filter(Boolean),
    denyPatterns,
  };
}

function compilePolicy(
  config: BashPolicyConfig,
  sourcePath: string,
): BashPolicy {
  const args = new Map<string, ArgRule>();
  if (config.args) {
    for (const [command, rule] of Object.entries(config.args)) {
      args.set(normalizeCommandName(command), compileArgRule(command, rule));
    }
  }

  return {
    sourcePath,
    enabled: config.enabled ?? true,
    mode: config.mode,
    commandBlacklist: new Set(
      (config.commands.blacklist || []).map(normalizeCommandName),
    ),
    commandWhitelist: new Set(
      (config.commands.whitelist || []).map(normalizeCommandName),
    ),
    denyBuiltins: new Set(
      (config.shell?.denyBuiltins || []).map(normalizeCommandName),
    ),
    denyOperators: new Set((config.shell?.denyOperators || []).map((op) => op)),
    args,
  };
}

export function loadBashPolicy(agentDir: string): BashPolicyLoadResult {
  const policyPath = path.join(agentDir, POLICY_RELATIVE_PATH);
  if (!fs.existsSync(policyPath)) {
    return { ok: true, found: false };
  }

  try {
    const stats = fs.statSync(policyPath);
    const cached = policyCache.get(policyPath);
    if (cached && cached.mtimeMs === stats.mtimeMs) {
      return { ok: true, found: true, policy: cached.policy };
    }

    const raw = fs.readFileSync(policyPath, 'utf-8');
    const json = JSON.parse(raw);
    const parsed = bashPolicySchema.safeParse(json);
    if (!parsed.success) {
      return {
        ok: false,
        error: `Invalid bash policy at ${policyPath}: ${parsed.error.message}`,
      };
    }

    const policy = compilePolicy(parsed.data, policyPath);
    policyCache.set(policyPath, { mtimeMs: stats.mtimeMs, policy });
    return { ok: true, found: true, policy };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Failed to load bash policy at ${policyPath}: ${message}`,
    };
  }
}

function hasDeniedOperator(
  rawCommand: string,
  denyOperators: Set<string>,
): boolean {
  if (denyOperators.size === 0) {
    return false;
  }

  if (denyOperators.has('&&') && rawCommand.includes('&&')) {
    return true;
  }
  if (denyOperators.has('||') && rawCommand.includes('||')) {
    return true;
  }
  if (denyOperators.has('|') && rawCommand.includes('|')) {
    return true;
  }
  if (denyOperators.has(';') && rawCommand.includes(';')) {
    return true;
  }
  if (denyOperators.has('&')) {
    const stripped = rawCommand.replace(/&&/g, '');
    if (stripped.includes('&')) {
      return true;
    }
  }

  return false;
}

function flagDenied(flag: string, args: string[]): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

export function evaluateBashCommandPolicy(
  policy: BashPolicy,
  command: string,
): BashPolicyDecision {
  if (!policy.enabled) {
    return { allowed: true };
  }

  if (hasDeniedOperator(command, policy.denyOperators)) {
    return {
      allowed: false,
      reason: `Blocked by bash policy (${policy.sourcePath}): command uses a denied shell operator.`,
    };
  }

  const segments = parseCommandSegments(command);
  for (const segment of segments) {
    if (policy.denyBuiltins.has(segment.command)) {
      return {
        allowed: false,
        reason: `Blocked by bash policy (${policy.sourcePath}): command "${segment.command}" is denied.`,
      };
    }

    if (
      policy.mode === 'whitelist' &&
      !policy.commandWhitelist.has(segment.command)
    ) {
      return {
        allowed: false,
        reason: `Blocked by bash policy (${policy.sourcePath}): command "${segment.command}" is not in whitelist.`,
      };
    }

    if (
      policy.mode === 'blacklist' &&
      policy.commandBlacklist.has(segment.command)
    ) {
      return {
        allowed: false,
        reason: `Blocked by bash policy (${policy.sourcePath}): command "${segment.command}" is blacklisted.`,
      };
    }

    const argRule = policy.args.get(segment.command);
    if (!argRule) {
      continue;
    }

    for (const denyFlag of argRule.denyFlags) {
      if (flagDenied(denyFlag, segment.args)) {
        return {
          allowed: false,
          reason: `Blocked by bash policy (${policy.sourcePath}): command "${segment.command}" uses denied flag "${denyFlag}".`,
        };
      }
    }

    if (argRule.allowFlags.length > 0) {
      for (const arg of segment.args) {
        if (!arg.startsWith('-')) {
          continue;
        }

        const isAllowed = argRule.allowFlags.some(
          (flag) => arg === flag || arg.startsWith(`${flag}=`),
        );

        if (!isAllowed) {
          return {
            allowed: false,
            reason: `Blocked by bash policy (${policy.sourcePath}): command "${segment.command}" uses non-allowed flag "${arg}".`,
          };
        }
      }
    }

    for (const denyPattern of argRule.denyPatterns) {
      if (denyPattern.test(segment.raw)) {
        return {
          allowed: false,
          reason: `Blocked by bash policy (${policy.sourcePath}): command "${segment.command}" matches denied pattern "${denyPattern.source}".`,
        };
      }
    }
  }

  return { allowed: true };
}
