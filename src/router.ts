import path from 'path';
import { AGENTS_DIR, SESSIONS_DIR } from './config.js';
import { Channel, NewMessage } from './types.js';
import { getAllRoutes } from './db.js';

/**
 * Convert a glob pattern to a regex.
 * Only supports * wildcards.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.replace(/\*/g, '.*') + '$');
}

/**
 * Calculate pattern specificity (more non-wildcard chars = more specific).
 */
function patternSpecificity(pattern: string): number {
  return pattern.replace(/\*/g, '').length;
}

/**
 * Parse a thread ID to extract platform and normalize for routing
 * Supports: discord:..., slack:..., teams:..., gchat:..., legacy dc:...
 */
export function parseThreadId(threadId: string): {
  platform: string;
  normalizedId: string;
  channelId: string;
} | null {
  const parts = threadId.split(':');
  if (parts.length < 2) return null;

  const platform = parts[0];

  // Handle different platform formats
  switch (platform) {
    case 'discord':
      // Format: discord:guildId:channelId or discord:guildId:channelId:threadId
      if (parts.length >= 3) {
        return {
          platform,
          normalizedId: threadId,
          channelId: parts[2],
        };
      }
      break;

    case 'slack':
      // Format: slack:teamId:channelId or slack:channelId
      if (parts.length >= 2) {
        return {
          platform,
          normalizedId: threadId,
          channelId: parts[parts.length - 1],
        };
      }
      break;

    case 'teams':
      // Format: teams:tenantId:channelId
      if (parts.length >= 3) {
        return {
          platform,
          normalizedId: threadId,
          channelId: parts[2],
        };
      }
      break;

    case 'gchat':
      // Format: gchat:spaceId:threadId
      if (parts.length >= 2) {
        return {
          platform,
          normalizedId: threadId,
          channelId: parts[1],
        };
      }
      break;

    case 'dc':
      // Legacy Discord format: dc:channelId
      return {
        platform: 'discord',
        normalizedId: `discord::${parts[1]}`,
        channelId: parts[1],
      };
  }

  return null;
}

/**
 * Resolve an agent ID from a thread ID.
 * Returns null if no route is defined for this ID.
 *
 * Supports multiple matching strategies (in order of priority):
 * 1. Exact match: 'discord:123:456' matches route 'discord:123:456'
 * 2. Short format: 'discord:456' matches route 'discord:456'
 * 3. Legacy format: 'dc:456' matches route 'dc:456'
 * 4. Wildcard patterns (sorted by specificity):
 *    - 'discord:123:*' matches 'discord:123:456' (guild-specific)
 *    - 'discord:*' matches all Discord channels
 *    - 'slack:*' matches all Slack channels
 *    - '*' matches everything
 *
 * Examples:
 *   Thread 'discord:987654321:123456789' matches:
 *     - 'discord:987654321:123456789' (exact)
 *     - 'discord:123456789' (short)
 *     - 'discord:987654321:*' (guild wildcard)
 *     - 'discord:*' (platform wildcard)
 *     - '*' (global wildcard)
 *
 * Handles all Chat SDK formats: discord:..., slack:..., teams:..., gchat:...
 * Also handles legacy formats: dc:... (auto-converted to discord::...)
 */
export async function resolveAgentId(threadId: string): Promise<string | null> {
  const dbRoutes = await getAllRoutes();
  // Fast path: exact match on full thread ID
  if (dbRoutes[threadId]) return dbRoutes[threadId];

  const patterns = Object.keys(dbRoutes)
    .filter((p) => p.includes('*'))
    .sort((a, b) => patternSpecificity(b) - patternSpecificity(a));

  for (const pattern of patterns) {
    if (globToRegex(pattern).test(threadId)) {
      return dbRoutes[pattern];
    }
  }

  // Parse the thread ID to extract platform and channel
  const parsed = parseThreadId(threadId);
  if (!parsed) return null;

  // Build list of formats to try matching against
  // Priority: most specific → least specific
  const formatsToTry = [
    threadId, // Full: discord:guildId:channelId
    `${parsed.platform}:${parsed.channelId}`, // Short: discord:channelId
    `dc:${parsed.channelId}`, // Legacy: dc:channelId
  ];

  // Try exact matches first
  for (const format of formatsToTry) {
    if (dbRoutes[format]) return dbRoutes[format];
  }

  // Check wildcard patterns (sorted by specificity - most specific first)
  // Try matching each pattern against all formats
  for (const pattern of patterns) {
    const regex = globToRegex(pattern);
    for (const format of formatsToTry) {
      if (regex.test(format)) {
        return dbRoutes[pattern];
      }
    }
  }

  return null;
}

/**
 * Get route information for a thread ID.
 * Returns the agent ID and thread ID for context.
 */
export async function getRouteInfo(
  threadId: string,
): Promise<{ threadId: string; agentId: string } | null> {
  const agentId = await resolveAgentId(threadId);
  if (!agentId) return null;
  return { threadId, agentId };
}

/**
 * Get the platform from a thread ID
 * e.g., "discord:123:456" -> "discord"
 */
export function getPlatformFromThreadId(threadId: string): string | null {
  const parsed = parseThreadId(threadId);
  return parsed?.platform || null;
}

/**
 * Get the filesystem path for an agent's folder.
 */
export function getAgentPath(agentId: string): string {
  return path.join(AGENTS_DIR, agentId);
}

/**
 * Get the filesystem path for a session's folder.
 * Uses thread ID to create a unique path.
 */
export function getSessionPath(threadId: string): string {
  // Sanitize thread ID for filesystem (replace colons and other special chars)
  const sanitizedId = threadId.replace(/[:@]/g, '_');
  return path.join(SESSIONS_DIR, sanitizedId);
}

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map(
    (m) =>
      `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`,
  );
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

// Safety net: strips any reasoning tags that weren't caught by middleware
export function stripReasoningTags(text: string): string {
  return text.replace(/<reasoning>[\s\S]*?<\/reasoning>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripReasoningTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

/**
 * Check if text is a NO_REPLY marker.
 * Returns true only if the trimmed text is exactly "NO_REPLY".
 * Used to suppress agent responses when no user-facing output is needed.
 */
export function isNoReply(text: string): boolean {
  return text.trim() === 'NO_REPLY';
}
