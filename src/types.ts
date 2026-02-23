export interface Agent {
  id: string; // Unique identifier (e.g., 'main', 'coding-agent')
  folder: string; // Folder name in agents/ (same as id by default)
  name: string; // Display name
  trigger: string; // Trigger pattern for activation
  added_at: string;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  modelProvider?: string;
  modelName?: string;
  isMain?: boolean; // Whether this is the main agent with special privileges
}

// Deprecated: keep for migration compatibility
export interface RegisteredGroup extends Agent {}

export interface Attachment {
  id: string;
  filename: string;
  path: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  attachments?: Attachment[];
}

export interface ScheduledTask {
  id: string;
  agent_id: string; // Changed from group_folder - which agent handles this task
  chat_jid: string; // Target JID for output
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  sendMessageWithAttachments?(
    jid: string,
    text: string,
    filePaths: string[],
  ): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Session represents a conversation state for a specific JID
export interface Session {
  jid: string; // Channel JID (e.g., 'dc:123', '123@g.us')
  agentId: string; // Which agent handles this session
  sessionId: string; // UUID for conversation history
  lastActivity?: string;
}

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (WhatsApp syncGroupMetadata) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
