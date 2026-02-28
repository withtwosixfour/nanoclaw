import { tool, type Tool } from 'ai';
import { truncateOutput } from '../context/truncate.js';
import { logger } from '../logger.js';
import { createBaseTools } from './tool-registry.js';

/**
 * Recursively truncate large string values in an object.
 * This handles deeply nested objects and arrays.
 */
function truncateObjectValues(
  obj: unknown,
  maxLines = 500,
  maxBytes = 100 * 1024,
): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    // Check if string is large enough to truncate
    const lines = obj.split('\n');
    const bytes = Buffer.byteLength(obj, 'utf-8');

    if (lines.length > maxLines || bytes > maxBytes) {
      const result = truncateOutput(obj, {
        maxLines,
        maxBytes,
        direction: 'head',
      });

      logger.debug(
        {
          originalLines: lines.length,
          truncatedLines: result.content.split('\n').length,
          originalBytes: bytes,
          truncated: result.truncated,
          outputPath: result.outputPath,
        },
        'Truncated tool output in tool wrapper',
      );

      return result.content;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => truncateObjectValues(item, maxLines, maxBytes));
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = truncateObjectValues(value, maxLines, maxBytes);
    }
    return result;
  }

  // For numbers, booleans, etc., return as-is
  return obj;
}

// Symbol to mark wrapped tools
const TRUNCATED_MARKER = Symbol('truncated');

function isTool(value: unknown): value is Tool<unknown, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'execute' in value &&
    typeof (value as { execute: unknown }).execute === 'function'
  );
}

/**
 * Wrap a tool function to truncate its output.
 * This intercepts the execute function and truncates the result before returning.
 */
export function wrapToolWithTruncation(
  toolObj: Tool<unknown, unknown>,
): Tool<unknown, unknown> {
  // Create a new object that wraps the original
  const wrapped: Tool<unknown, unknown> = { ...toolObj };

  // Check if this is a tool-like object with an execute function
  const originalExecute = wrapped.execute;
  if (typeof originalExecute === 'function') {
    // Replace execute with a wrapped version
    wrapped.execute = async (input, options) => {
      // Execute the original tool
      const result = await originalExecute(input, options);

      // Truncate the result
      const truncatedResult = truncateObjectValues(result);

      return truncatedResult;
    };
  }

  return wrapped;
}

/**
 * Wrap all tools in a registry with truncation.
 */
export function wrapToolRegistryWithTruncation(
  tools: ReturnType<typeof createBaseTools>,
) {
  const wrapped: Record<string, unknown> = {};

  for (const [key, tool] of Object.entries(tools)) {
    if (isTool(tool)) {
      wrapped[key] = wrapToolWithTruncation(tool);
    } else {
      wrapped[key] = tool;
    }
  }

  return wrapped;
}
