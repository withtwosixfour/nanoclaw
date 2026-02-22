import path from 'path';
import { AGENTS_DIR, SESSIONS_DIR } from './config.js';
import { Channel, NewMessage } from './types.js';

/**
 * Hardcoded routing map: JID -> Agent ID
 * Add your Discord channels and WhatsApp groups here.
 */
export const ROUTES: Record<string, string> = {
  // Discord channels - add your channel IDs here
  // Format: 'dc:{channelId}': '{agent-id}'
  // Example: 'dc:1234567890123456': 'main',
  // WhatsApp groups
  // Format: '{groupId}@g.us': '{agent-id}'
  // WhatsApp DMs
  // Format: '{phone}@s.whatsapp.net': '{agent-id}'
};

/**
 * Resolve an agent ID from a JID using the hardcoded ROUTES map.
 * Returns null if no route is defined for this JID.
 */
export function resolveAgentId(jid: string): string | null {
  return ROUTES[jid] || null;
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

/**
 * Add a route to the ROUTES map (useful for dynamic registration during migration).
 */
export function addRoute(jid: string, agentId: string): void {
  ROUTES[jid] = agentId;
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

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
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
