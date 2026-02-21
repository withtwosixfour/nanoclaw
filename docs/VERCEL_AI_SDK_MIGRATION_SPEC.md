## Vercel AI SDK Migration Spec

### Goal

Migrate NanoClaw from `@anthropic-ai/claude-agent-sdk` to Vercel AI SDK Core while preserving the repo’s core principles: small, understandable, secure-by-isolation, and code-first customization. Remove Agent Teams support. Implement optimistic background compaction at 60% context usage with last two full exchanges preserved.

### Scope

- Replace container-side agent runtime with Vercel AI SDK (`streamText`).
- Keep existing host orchestration, IPC, and container model.
- Keep MCP server (`ipc-mcp-stdio.ts`) unchanged.
- Add per-group model selection in `registered_groups`.
- Add global default model configuration in code (own file).
- Implement background compaction triggered at 60% of context window.

### Non-Goals

- Agent Teams / TeamCreate / TeamDelete.
- New migrations framework.
- New external services or UIs.

---

## Architecture Overview

Host (Node process) remains unchanged except for passing model config to the container:

- `src/index.ts` and `src/container-runner.ts` keep orchestration and IPC.
- `src/db.ts` receives inline schema changes.

Container (agent-runner) is replaced:

- `container/agent-runner/src/index.ts` uses Vercel AI SDK.
- `container/agent-runner/src/model-config.ts` stores model defaults and thresholds.
- `container/agent-runner/src/session-store.ts` persists session messages.
- `container/agent-runner/src/tools/*` implements tools explicitly.

---

## Data Model Changes (Inline in `src/db.ts`)

### 1) `registered_groups` additions

Add columns (inline, try/catch as existing pattern):

- `model_provider` TEXT DEFAULT `'anthropic'`
- `model_name` TEXT DEFAULT `'claude-3-5-sonnet-20241022'`

### 2) `conversation_history` table

Create table if not exists:

- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `group_folder` TEXT NOT NULL
- `session_id` TEXT NOT NULL
- `role` TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool'))
- `content` TEXT
- `tool_calls` TEXT (JSON)
- `tool_results` TEXT (JSON)
- `token_count` INTEGER
- `created_at` TEXT NOT NULL

Indexes:

- `(group_folder, session_id)`
- `(created_at)`

---

## Model Config (Code-First)

### File: `container/agent-runner/src/model-config.ts`

**Purpose:** Provide static defaults and compaction threshold helpers.

**Default model (global):**

- provider: `anthropic`
- model: `claude-3-5-sonnet-20241022`
- contextWindow: `200000`
- maxOutputTokens: `8192`
- compactionThresholdPercent: `60`

**API:**

- `getModelConfig(provider, modelName): ModelConfig`
- `getCompactionThreshold(config): number`
- `getDefaultModel(): { provider; modelName; }`

Fallback behavior:

- If a provider/model is unknown, use the default config (200k window).

---

## Session Store (Container)

### File: `container/agent-runner/src/session-store.ts`

**Responsibilities:**

- Load messages per session (CoreMessage[])
- Persist messages with token usage
- Compute total token usage for a session
- Replace session messages after compaction

**Key Functions:**

- `getOrCreateSessionId(groupFolder): string`
- `loadMessages(groupFolder, sessionId): CoreMessage[]`
- `saveMessage(groupFolder, sessionId, message, tokenCount): void`
- `getSessionTokenCount(sessionId): number`
- `replaceSessionMessages(groupFolder, sessionId, messages): void`

---

## Optimistic Compaction (60% Threshold)

### Behavior

- If `currentTokens >= 0.6 * (contextWindow - maxOutputTokens)`, trigger compaction.
- Compaction runs in background (fire-and-forget) so the current request is not delayed.
- Next message uses compacted session state.
- Preserve **last two full exchanges** including tool calls/results.

### Compaction Algorithm

1. Load all session messages.
2. Archive full transcript to `/workspace/group/conversations`.
3. Split into:
   - `recent`: last two exchanges (user + assistant, including tool calls/results).
   - `older`: everything before.
4. Summarize `older` using the active model (or default unless configured otherwise).
5. Replace session messages with:
   - System summary message
   - `recent` messages

### Token Counting

- Use `usage.totalTokens` from `streamText` `onFinish`.
- Store per-message token counts for accurate totals.

---

## Tools (Explicit Implementations)

### Directory: `container/agent-runner/src/tools/`

Required tools:

- `bash.ts` (with secret scrubbing)
- `fs.ts` (Read/Write/Edit/Glob/Grep)
- `web.ts` (WebSearch/WebFetch)
- `mcp.ts` (MCP client wrapper for `ipc-mcp-stdio.ts`)
- `index.ts` (exports tool registry)

Notes:

- Remove TeamCreate/TeamDelete.
- Keep MCP tools intact; they are surfaced via MCP client.

---

## Core Runner Rewrite

### File: `container/agent-runner/src/index.ts`

Replace `query()` loop with `streamText()`:

- Load session messages.
- Build system prompt from `/workspace/group/CLAUDE.md`.
- Append `/workspace/global/CLAUDE.md` if non-main.
- Determine model from `ContainerInput` or defaults.
- Trigger compaction if threshold met (async, no await).
- Stream output to stdout with existing markers.
- On finish: save assistant response + token usage.

### Container Input Additions

- `modelProvider?: string`
- `modelName?: string`

---

## Host Changes

### `src/container-runner.ts`

- Read `model_provider` and `model_name` from `registered_groups`.
- Pass into `ContainerInput`.
- Provide fallback to global defaults if empty.

---

## Default Behaviors

- Per-group model selection in `registered_groups`.
- Global defaults provided in `model-config.ts`.
- Context window default: 200k.
- Compaction threshold: 60% of usable context.
- Preserve last two full exchanges after compaction.

---

## Testing Checklist

1. Basic chat flow (no tools)
2. Tool calls: Bash, Read, Write, Edit
3. MCP tool calls: send_message, schedule_task
4. Session persistence across restarts
5. Compaction triggers at 60% threshold
6. Last two exchanges preserved post-compaction
7. Per-group model override works

---

## Open Items (Optional Later)

- Add additional model entries to `model-config.ts` if needed.
- Allow compaction model override if cost becomes a concern.
- Add internal metrics for compaction duration and size.
