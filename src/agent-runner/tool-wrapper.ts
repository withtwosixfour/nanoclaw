import { tool, type Tool } from 'ai';
import { truncateOutput } from '../context/truncate.js';
import { logger } from '../logger.js';
import { createBaseTools } from './tool-registry.js';
import type { ToolSet } from 'ai';

/**
 * Recursively truncate large string values in an object.
 * This handles deeply nested objects and arrays.
 */
function truncateObjectValues(
  obj: unknown,
  maxLines = 500,
  maxBytes = 100 * 1024,
  path: string[] = [],
): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    const currentKey = path[path.length - 1];

    // Preserve binary payloads (for example image base64 data)
    if (currentKey === 'base64') {
      return obj;
    }

    // Check if string is large enough to truncate
    const lines = obj.split('\n');
    const bytes = Buffer.byteLength(obj, 'utf-8');

    if (lines.length > maxLines || bytes > maxBytes) {
      if (currentKey === 'data') {
        logger.warn(
          {
            path: path.join('.'),
            bytes,
            lines: lines.length,
            maxBytes,
            maxLines,
          },
          'Potential image payload truncation on data field',
        );
      }

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
    return obj.map((item) =>
      truncateObjectValues(item, maxLines, maxBytes, path),
    );
  }

  if (typeof obj === 'object') {
    // Preserve AI SDK image-data parts as-is
    if (
      'type' in obj &&
      (obj as Record<string, unknown>).type === 'image-data' &&
      typeof (obj as Record<string, unknown>).data === 'string'
    ) {
      logger.debug(
        {
          path: path.join('.'),
          dataBytes: Buffer.byteLength(
            (obj as Record<string, unknown>).data as string,
            'utf-8',
          ),
          mediaType: (obj as Record<string, unknown>).mediaType,
        },
        'Preserving image-data payload in tool wrapper',
      );
      return obj;
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = truncateObjectValues(value, maxLines, maxBytes, [
        ...path,
        key,
      ]);
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
  toolName = 'unknown',
): Tool<unknown, unknown> {
  // Create a new object that wraps the original
  const wrapped: Tool<unknown, unknown> = { ...toolObj };

  // Check if this is a tool-like object with an execute function
  const originalExecute = wrapped.execute;
  if (typeof originalExecute === 'function') {
    // Replace execute with a wrapped version
    wrapped.execute = async (input, options) => {
      const startedAt = Date.now();
      const inputBytes = Buffer.byteLength(
        JSON.stringify(input ?? {}),
        'utf-8',
      );

      logger.debug(
        {
          toolName,
          inputBytes,
        },
        'Tool call started',
      );

      try {
        // Execute the original tool
        const result = await originalExecute(input, options);

        // Truncate the result
        const truncatedResult = truncateObjectValues(result);

        const rawOutputBytes = Buffer.byteLength(
          JSON.stringify(result ?? {}),
          'utf-8',
        );
        const returnedOutputBytes = Buffer.byteLength(
          JSON.stringify(truncatedResult ?? {}),
          'utf-8',
        );

        logger.debug(
          {
            toolName,
            durationMs: Date.now() - startedAt,
            rawOutputBytes,
            returnedOutputBytes,
            outputShrunk: returnedOutputBytes < rawOutputBytes,
          },
          'Tool call completed',
        );

        return truncatedResult;
      } catch (err) {
        logger.error(
          {
            toolName,
            durationMs: Date.now() - startedAt,
            err,
          },
          'Tool call failed',
        );
        throw err;
      }
    };
  }

  return wrapped;
}

/**
 * Wrap all tools in a registry with truncation.
 */
export function wrapToolRegistryWithTruncation(
  tools: ReturnType<typeof createBaseTools>,
): ToolSet {
  const wrapped: Record<string, Tool<unknown, unknown>> = {};

  for (const [key, tool] of Object.entries(tools)) {
    if (isTool(tool)) {
      wrapped[key] = wrapToolWithTruncation(tool, key);
    } else {
      wrapped[key] = tool as Tool<unknown, unknown>;
    }
  }

  return wrapped as ToolSet;
}
