## Updates
You can update yourself by running npm run update in ~/nanoclaw

## Architectural Changes (v2.0)

**The system has been restructured from a "groups" model to an "agents + sessions" model.**

### Old Approach (Pre-v2.0)

- `groups/{folder}/` - Combined agent configuration AND conversation state
- Each group folder had `.nanoclaw/` with conversation state
- JID-to-group mapping was implicit and hard to change

### New Approach (v2.0+)

- `agents/{id}/` - **Agent definitions only** (CLAUDE.md, tools, configuration)
- `sessions/{jid}/` - **Conversation state per channel** (JID-based)
- `src/router.ts` - **Explicit routing** from JID to agent via ROUTES map
- Multiple channels can share the same agent while maintaining independent conversation histories

**Migration:** The system automatically migrates on first startup:

1. Renames `groups/` to `agents/`
2. Moves `.nanoclaw/*` to `sessions/{jid}/`
3. Preserves JID mappings from old `registered_groups` table

## What You Can Do

- Answer questions and have conversations
- Search the web and fetch content from URLs
- **Browse the web** with `agent-browser` — open pages, click, fill forms, take screenshots, extract data (run `agent-browser open <url>` to start, then `agent-browser snapshot -i` to see interactive elements)
- Read and write files in your workspace
- Run bash commands in your sandbox
- Schedule tasks to run later or on a recurring basis
- Send messages back to the chat

## Communication

Your output is sent to the user or group.

You also have `mcp__nanoclaw__send_message` which sends a message immediately while you're still working. This is useful when you want to acknowledge a request before starting longer work.

### Internal thoughts

If part of your output is internal reasoning rather than something for the user, wrap it in `<internal>` tags:

```
<internal>Compiled all three reports, ready to summarize.</internal>

Here are the key findings from the research...
```

Text inside `<internal>` tags is logged but not sent to the user. If you've already sent the key information via `send_message`, you can wrap the recap in `<internal>` to avoid sending it again.

### Sub-agents and teammates

When working as a sub-agent or teammate, only use `send_message` if instructed to by the main agent.

## Your Workspace

Files you create are saved in `/workspace/agent/` (formerly `/workspace/group/`). Use this for notes, research, or anything that should persist.

**Note:** The old `/workspace/group/` path has been replaced with `/workspace/agent/` to reflect the new agents/ structure. Sessions are now stored separately per JID in `/workspace/project/sessions/`.

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
