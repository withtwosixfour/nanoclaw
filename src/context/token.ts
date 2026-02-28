/**
 * Token estimation utility for context management.
 * Uses the industry-standard heuristic: characters / 4
 */

const CHARS_PER_TOKEN = 4;

/**
 * Estimate token count for a string.
 * @param text The text to estimate
 * @returns Estimated token count
 */
export function estimateTokens(text: string): number {
  return Math.max(0, Math.round((text || '').length / CHARS_PER_TOKEN));
}

/**
 * Estimate tokens for multiple strings.
 * @param texts Array of strings to estimate
 * @returns Total estimated token count
 */
export function estimateTokensBatch(texts: string[]): number {
  let total = 0;
  for (const text of texts) {
    total += estimateTokens(text);
  }
  return total;
}
