import path from 'path';
import { AGENTS_DIR, SESSIONS_DIR } from './config.js';
import { Channel, NewMessage } from './types.js';

// Database-backed routes (populated from DB on startup)
let dbRoutes: Record<string, string> = {};

/**
 * Load routes from database into memory.
 * Called during startup after database initialization.
 */
export function loadRoutesFromDb(routes: Record<string, string>): void {
  dbRoutes = routes;
}

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
 * Resolve an agent ID from a JID.
 * Returns null if no route is defined for this JID.
 * Supports wildcard patterns using * (e.g., "whatsapp:*", "dc:*", "*").
 */
export function resolveAgentId(jid: string): string | null {
  // Fast path: exact match
  if (dbRoutes[jid]) return dbRoutes[jid];

  // Check wildcard patterns (sorted by specificity descending)
  const patterns = Object.keys(dbRoutes)
    .filter((p) => p.includes('*'))
    .sort((a, b) => patternSpecificity(b) - patternSpecificity(a));

  for (const pattern of patterns) {
    if (globToRegex(pattern).test(jid)) {
      return dbRoutes[pattern];
    }
  }

  return null;
}

/**
 * Get all routed JIDs (in-memory cache loaded from DB).
 */
export function getRouteJids(): string[] {
  return Object.keys(dbRoutes);
}

/**
 * Update the in-memory route cache.
 * Note: This only updates memory. To persist, use setRoute() from db.ts.
 */
export function setRouteInMemory(jid: string, agentId: string): void {
  dbRoutes[jid] = agentId;
}

/**
 * Remove a route from the in-memory cache.
 * Note: This only updates memory. To persist, use deleteRoute() from db.ts.
 */
export function deleteRouteInMemory(jid: string): void {
  delete dbRoutes[jid];
}

/**
 * Get route information for a JID.
 * Returns the agent ID and JID for context.
 */
export function getRouteInfo(
  jid: string,
): { jid: string; agentId: string } | null {
  const agentId = resolveAgentId(jid);
  if (!agentId) return null;
  return { jid, agentId };
}

/**
 * Get the filesystem path for an agent's folder.
 */
export function getAgentPath(agentId: string): string {
  return path.join(AGENTS_DIR, agentId);
}

/**
 * Get the filesystem path for a session's folder.
 */
export function getSessionPath(jid: string): string {
  // Sanitize JID for filesystem (replace colons and other special chars)
  const sanitizedJid = jid.replace(/[:@]/g, '_');
  return path.join(SESSIONS_DIR, sanitizedJid);
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
