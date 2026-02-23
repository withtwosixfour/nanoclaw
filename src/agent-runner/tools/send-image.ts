import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { tool } from 'ai';

export const SendImage = tool({
  description: `Send an image file to the user in the chat. Use this tool when:
- You have generated or created an image file
- You want to share a screenshot or visual content
- You need to show the user something visual
- The user asks you to send an image

The image will be attached to your message and sent to the chat.`,
  inputSchema: z.object({
    filePath: z
      .string()
      .describe(
        'Absolute path to the image file to send (e.g., /app/store/attachments/image.png or /app/agents/global/workspace/chart.png)',
      ),
    caption: z
      .string()
      .optional()
      .describe('Optional text caption or message to accompany the image'),
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
      const ext = path.extname(input.filePath).toLowerCase();
      const validImageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];

      if (!validImageExts.includes(ext)) {
        return {
          error: `File is not a supported image format. Supported: ${validImageExts.join(', ')}`,
        };
      }

      // Return success - actual sending happens in runtime
      return {
        success: true,
        filePath: input.filePath,
        fileName,
        fileSize,
        caption: input.caption || '',
      };
    } catch (err) {
      return {
        error: `Failed to send image: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
