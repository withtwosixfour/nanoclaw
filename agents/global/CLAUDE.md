## Updates

You can update yourself by running npm run update in ~/nanoclaw

## What You Can Do

- Answer questions and have conversations
- Search the web and fetch content from URLs
- **Browse the web** with `agent-browser` — open pages, click, fill forms, take screenshots, extract data (run `agent-browser open <url>` to start, then `agent-browser snapshot -i` to see interactive elements)
- Read and write files in your workspace
- Run bash commands in your sandbox
- Schedule tasks to run later or on a recurring basis
- Send messages back to the chat
- **Send attachments** using the `SendAttachment` tool — share any file (images, documents, code files, etc.) with the user

## Communication

Your output is sent to the user or group.

You also have `mcp__nanoclaw__send_message` which sends a message immediately while you're still working. This is useful when you want to acknowledge a request before starting longer work.

## Silent Responses (NO_REPLY)

When you don't need to send a visible response to the user, output exactly:

NO_REPLY

This will suppress any message from being sent. Useful for:

- Silent background operations
- When the work is self-evident (file created, task scheduled)
- Housekeeping tasks with no user-facing result

The output must be ONLY "NO_REPLY" (whitespace is trimmed, no formatting, just the raw NO_REPLY message). This works for both regular conversations and scheduled tasks.

## Sending Attachments

You can send files to the chat using the `SendAttachment` tool:

- Use it when you've generated or created any file
- Share images, screenshots, charts, diagrams, documents, code files, etc.
- When the user asks you to share a file

The tool accepts:

- `filePath`: Absolute path to the file (e.g., `/app/store/attachments/file.pdf` or `/app/agents/global/workspace/chart.png`)
- `caption` (optional): Text to accompany the file

Any file type is supported.

### Sub-agents and teammates

When working as a sub-agent or teammate, only use `send_message` if instructed to by the main agent.

## Your Workspace

Files you create are saved in your working directory (`/agents/{agentName}` in the overall nanoclaw project). Use this for notes, research, or anything that should persist.

## Update and Restart (Host)

Run these commands from `/home/ubuntu/nanoclaw`:

```
npm install
npm run build
systemctl --user restart nanoclaw
```

Check status/logs:

```
systemctl --user status nanoclaw
tail -f logs/nanoclaw.log
```

## Memory

The `conversations/` folder contains searchable history of past conversations. Use this to recall context from previous sessions.

When you learn something important:

- Create files for structured data (e.g., `customers.md`, `preferences.md`)
- Split files larger than 500 lines into folders
- Keep an index in your memory for the files you create

## Message Formatting

NEVER use markdown. Only use WhatsApp/Telegram formatting:

- _single asterisks_ for bold (NEVER **double asterisks**)
- _underscores_ for italic
- • bullet points
- `triple backticks` for code

No ## headings. No [links](url). No **double stars**.
