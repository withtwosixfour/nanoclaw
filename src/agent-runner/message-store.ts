import type { ModelMessage, ToolCallPart, ToolResultPart } from 'ai';

import { truncateOutput } from '../context/truncate.js';

export interface LegacyConversationRow {
  role: string;
  content: string | null;
  toolCalls: string | null;
  toolResults: string | null;
}

export function normalizeMessageForStorage(
  message: ModelMessage,
): ModelMessage {
  if (message.role !== 'tool' || !Array.isArray(message.content)) {
    return message;
  }

  return {
    ...message,
    content: message.content.map((part) => {
      if (!isToolResultPart(part) || typeof part.output !== 'string') {
        return part;
      }

      const truncateResult = truncateOutput(part.output, {
        maxLines: 500,
        maxBytes: 100 * 1024,
        direction: 'head',
      });

      return {
        ...part,
        output: truncateResult.content,
      } as unknown as ToolResultPart;
    }),
  };
}

export function serializeMessageForStorage(message: ModelMessage): string {
  return JSON.stringify(normalizeMessageForStorage(message));
}

export function deserializeStoredMessage(serialized: string): ModelMessage {
  return JSON.parse(serialized) as ModelMessage;
}

export function repairMessageHistory(messages: ModelMessage[]): ModelMessage[] {
  const assistantToolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isToolCallPart(part)) {
          assistantToolCallIds.add(part.toolCallId);
        }
      }
    }

    if (message.role === 'tool' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isToolResultPart(part)) {
          toolResultIds.add(part.toolCallId);
        }
      }
    }
  }

  const validToolCallIds = new Set<string>();
  for (const toolCallId of assistantToolCallIds) {
    if (toolResultIds.has(toolCallId)) {
      validToolCallIds.add(toolCallId);
    }
  }

  return messages.flatMap((message) => {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      const content = message.content.filter(
        (part) =>
          !isToolCallPart(part) || validToolCallIds.has(part.toolCallId),
      );

      if (content.length === 0) {
        return [];
      }

      if (
        content.length === 1 &&
        content[0] &&
        typeof content[0] === 'object' &&
        (content[0] as { type?: unknown }).type === 'text' &&
        typeof (content[0] as { text?: unknown }).text === 'string'
      ) {
        return [
          {
            role: 'assistant',
            content: (content[0] as { text: string }).text,
          } satisfies ModelMessage,
        ];
      }

      return [{ ...message, content }];
    }

    if (message.role === 'tool' && Array.isArray(message.content)) {
      const content = message.content.filter(
        (part) =>
          !isToolResultPart(part) || validToolCallIds.has(part.toolCallId),
      );

      if (content.length === 0) {
        return [];
      }

      return [{ ...message, content }];
    }

    return [message];
  });
}

export function convertLegacyRowToMessage(
  row: LegacyConversationRow,
): ModelMessage {
  if (row.role === 'tool') {
    return normalizeMessageForStorage({
      role: 'tool',
      content: parseToolResults(row.toolResults),
    });
  }

  if (row.role === 'assistant') {
    const text = row.content?.trim() ?? '';
    const toolCalls = parseToolCalls(row.toolCalls);

    if (toolCalls.length === 0) {
      return {
        role: 'assistant',
        content: text,
      };
    }

    const content: Array<{ type: 'text'; text: string } | ToolCallPart> = [];
    if (text) {
      content.push({ type: 'text', text });
    }
    content.push(...toolCalls);

    return {
      role: 'assistant',
      content,
    };
  }

  if (row.role === 'system') {
    return { role: 'system', content: row.content ?? '' };
  }

  return { role: 'user', content: row.content ?? '' };
}

export function getToolPayloadForPruning(message: ModelMessage): string | null {
  if (message.role !== 'tool' || !Array.isArray(message.content)) {
    return null;
  }

  if (message.content.length === 0) {
    return null;
  }

  return JSON.stringify(message.content);
}

export function getToolNames(message: ModelMessage): string[] {
  if (message.role !== 'tool' || !Array.isArray(message.content)) {
    return [];
  }

  return message.content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return null;
      }

      const toolName = (part as { toolName?: unknown }).toolName;
      return typeof toolName === 'string' ? toolName : null;
    })
    .filter((toolName): toolName is string => typeof toolName === 'string')
    .filter((toolName, index, names) => names.indexOf(toolName) === index);
}

function isToolCallPart(part: unknown): part is ToolCallPart {
  return (
    !!part &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'tool-call' &&
    typeof (part as { toolName?: unknown }).toolName === 'string' &&
    typeof (part as { toolCallId?: unknown }).toolCallId === 'string'
  );
}

function parseToolCalls(serialized: string | null): ToolCallPart[] {
  if (!serialized) return [];

  let parsed: Array<{
    toolName: string;
    toolCallId: string;
    input: unknown;
  }>;
  try {
    parsed = JSON.parse(serialized) as Array<{
      toolName: string;
      toolCallId: string;
      input: unknown;
    }>;
  } catch {
    return [];
  }

  return parsed.map((part) => ({
    type: 'tool-call' as const,
    toolName: part.toolName,
    toolCallId: part.toolCallId,
    input: part.input,
  }));
}

function parseToolResults(serialized: string | null): ToolResultPart[] {
  if (!serialized) return [];
  try {
    return JSON.parse(serialized) as ToolResultPart[];
  } catch {
    return [];
  }
}

function isToolResultPart(part: unknown): part is ToolResultPart {
  return (
    !!part &&
    typeof part === 'object' &&
    (part as { type?: unknown }).type === 'tool-result' &&
    typeof (part as { toolName?: unknown }).toolName === 'string' &&
    typeof (part as { toolCallId?: unknown }).toolCallId === 'string'
  );
}
