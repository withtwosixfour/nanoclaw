import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { tool } from 'ai';

export const SendAttachment = tool({
  description: `Send a file attachment to the user in the chat. Use this tool when:
- You have generated or created any file (image, document, code, etc.)
- You want to share a file with the user
- The user asks you to send a file

The file will be attached to your message and sent to the chat.`,
  inputSchema: z.object({
    filePath: z
      .string()
      .describe(
        'Absolute path to the file to send (e.g., /app/store/attachments/file.pdf or /app/agents/global/workspace/chart.png)',
      ),
    caption: z
      .string()
      .optional()
      .describe('Optional text to accompany the file'),
  }),
  execute: async (input: { filePath: string; caption?: string }) => {
    try {
      // Validate file exists
      if (!fs.existsSync(input.filePath)) {
        return {
          error: `File not found: ${input.filePath}`,
        };
      }

      // Validate it's a file (not directory)
      const stat = fs.statSync(input.filePath);
      if (!stat.isFile()) {
        return {
          error: `Path is not a file: ${input.filePath}`,
        };
      }

      // Get file info
      const fileName = path.basename(input.filePath);
      const fileSize = stat.size;

      // Return success - actual sending happens in runtime
      return {
        success: true,
        filePath: input.filePath,
        fileName,
        fileSize,
        caption: input.caption,
      };
    } catch (err) {
      return {
        error: `Failed to send attachment: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
