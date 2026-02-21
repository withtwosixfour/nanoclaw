import { z } from 'zod';
import { tool } from 'ai';

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Fetch failed (${res.status} ${res.statusText})`);
  }
  return await res.text();
}

export function createWebTools() {
  return {
    WebFetch: tool({
      description: 'Fetch the contents of a URL as text.',
      inputSchema: z.object({
        url: z.string().url().describe('URL to fetch'),
      }),
      execute: async (input: { url: string }) => {
        const text = await fetchText(input.url);
        return { url: input.url, content: text };
      },
    }),
    WebSearch: tool({
      description: 'Search the web and return top results.',
      inputSchema: z.object({
        query: z.string().describe('Search query'),
        limit: z.number().int().optional().describe('Max number of results'),
      }),
      execute: async (input: { query: string; limit?: number }) => {
        const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
        const html = await fetchText(url);
        const results: Array<{ title: string; url: string }> = [];
        const regex =
          /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/g;
        let match: RegExpExecArray | null;
        while (
          (match = regex.exec(html)) &&
          results.length < (input.limit || 5)
        ) {
          const rawTitle = match[2].replace(/<[^>]+>/g, '').trim();
          results.push({ title: rawTitle, url: match[1] });
        }
        return { query: input.query, results };
      },
    }),
  };
}
