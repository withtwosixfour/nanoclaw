# Context Management Implementation Spec

## Overview

This document outlines the implementation of opencode-style context management for nanoclaw, combining both approaches: **soft compaction** (filtering at load time) and **markdown archiving** (full backup), with continuous **pruning** of old tool outputs.

---

## Architecture Layers

### Layer 1: Tool Output Truncation (Per-Tool)

**File:** `src/context/truncate.ts`

Limits individual tool outputs before they even reach the conversation history.

- **Limits:**
  - Max lines: 2000 (configurable)
  - Max bytes: 50KB (configurable)
  - Direction: "head" (first N lines) or "tail" (last N lines)

- **Behavior:**
  1. Check if output exceeds limits
  2. If yes, write full output to `data/tool-output/{uuid}.txt`
  3. Return truncated content with hint:
     ```
     {truncated_content}
     ...{N} lines truncated...
     Full output saved to: data/tool-output/{uuid}.txt
     Use Task tool with Grep/Read (offset/limit) to access this file.
     ```

- **Storage:**
  - Directory: `data/tool-output/`
  - Files: `tool_{timestamp}_{uuid}.txt`
  - Retention: 7 days (cleanup job)

- **Interface:**

  ```typescript
  export interface TruncateOptions {
    maxLines?: number; // default 2000
    maxBytes?: number; // default 51200 (50KB)
    direction?: 'head' | 'tail'; // default 'head'
  }

  export interface TruncateResult {
    content: string;
    truncated: boolean;
    outputPath?: string; // only if truncated
  }

  export async function truncateOutput(
    text: string,
    options?: TruncateOptions,
  ): Promise<TruncateResult>;

  export async function cleanupOldOutputs(): Promise<void>;
  ```

---

### Layer 2: Token Estimation

**File:** `src/context/token.ts`

Simple token estimation for making context management decisions without calling the model.

- **Algorithm:** Characters / 4 (industry standard heuristic)
- **Interface:**
  ```typescript
  export function estimateTokens(text: string): number {
    return Math.max(0, Math.round((text || '').length / 4));
  }
  ```

---

### Layer 3: Pruning (After Every Turn)

**File:** `src/context/prune.ts`

Runs continuously after each assistant response to keep tool output accumulation under control.

**Algorithm (from opencode):**

```
1. Walk backwards through conversation history
2. Track total tokens in tool outputs
3. Protect:
   - Last 2 user turns (user messages)
   - "skill" tool outputs (never prune these)
   - Already compacted tools (stop if we hit one)
4. When total > PRUNE_PROTECT (40k tokens):
   - Mark older tool outputs with compacted_at timestamp
5. Actually prune only if pruned > PRUNE_MINIMUM (20k tokens)
```

**Constants:**

```typescript
const PRUNE_MINIMUM = 20_000; // Must exceed this to actually prune
const PRUNE_PROTECT = 40_000; // Protection threshold
const PRUNE_PROTECTED_TOOLS = ['skill']; // Never prune these
```

**Interface:**

```typescript
export interface PruneResult {
  pruned: number; // tokens pruned
  total: number; // total tokens scanned
  count: number; // number of messages marked
}

export async function pruneToolOutputs(
  jid: string,
  sessionId: string,
): Promise<PruneResult>;
```

**Behavior:**

- Marks tool results with `compacted_at = ISO timestamp`
- Does NOT delete anything
- When loading for LLM, compacted tools show: "[Old tool result content cleared]"

---

### Layer 4: Message Loading & Filtering

**File:** `src/context/filter.ts`

Controls what gets sent to the LLM.

**Functions:**

1. **`loadContextForModel(jid, sessionId)`**
   - Loads only uncompacted messages
   - Stops at first compaction marker
   - Converts tool outputs based on compaction status
   - Used when sending to LLM

2. **`loadAllMessages(jid, sessionId)`**
   - Loads everything (for archiving/UI)
   - Ignores compaction markers

3. **`filterCompacted(messages)`**
   - Takes array of messages
   - Returns array stopping at compaction point
   - Reverses order (oldest first for LLM)

**Message Conversion:**

```typescript
// When converting tool result for LLM:
if (toolResult.compacted_at) {
  output = '[Old tool result content cleared]';
  attachments = []; // Clear attachments too
} else {
  output = toolResult.content;
  attachments = toolResult.attachments;
}
```

---

### Layer 5: Compaction (When Context Fills)

**Modify:** `src/agent-runner/runtime.ts`

Full compaction happens when approaching context window limits.

#### Mid-Stream Overflow Detection

During `streamText()`:

```typescript
onFinish: (event) => {
  const usageTokens = event.totalUsage?.totalTokens ?? 0;
  const threshold = getCompactionThreshold(config);

  if (usageTokens > threshold) {
    needsCompaction = true;
  }
};
```

If `needsCompaction` is true:

1. Return `"compact"` from runQuery
2. Trigger compaction before next turn
3. Add synthetic compaction user message

#### Compaction Process

**Phase 1: Archive to Markdown (keep nanoclaw behavior)**

```typescript
// Save to sessions/{jid}/conversations/{date}-{sessionId}.md
const archivePath = path.join(
  SESSIONS_DIR,
  sanitizedJid,
  'conversations',
  `${date}-${sessionId.slice(0, 8)}.md`,
);

// Format as markdown with timestamps and roles
const markdown = formatTranscriptMarkdown(allMessages);
fs.writeFileSync(archivePath, markdown);
```

**Phase 2: Soft Compaction**

```typescript
// Split messages
const userIndexes = messages
  .map((msg, idx) => (msg.role === 'user' ? idx : -1))
  .filter((idx) => idx !== -1);

// Keep last 2 user turns
const splitIndex = userIndexes[userIndexes.length - 2];
const older = messages.slice(0, splitIndex); // Will be compacted
const recent = messages.slice(splitIndex); // Keep as-is

// Generate summary of older messages
const summary = await generateCompactionSummary(older);

// Create summary system message
const summaryMessage = {
  role: 'system',
  content: `Summary of earlier conversation:\n${summary}`,
  is_compacted_summary: true,
  original_message_count: older.length,
};

// Mark older messages in DB
markMessagesCompacted(jid, sessionId, splitIndex);

// Store: summary + recent messages
replaceSessionMessages(jid, sessionId, [summaryMessage, ...recent]);
```

**Summary Generation:**

- Use dedicated compaction agent or current agent
- Prompt: "Provide a detailed prompt for continuing our conversation above. Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next."

---

## Database Schema Updates

**Modify:** `src/agent-runner/session-store.ts`

```sql
-- Add compaction tracking columns
ALTER TABLE conversation_history
ADD COLUMN is_compacted BOOLEAN DEFAULT FALSE;

ALTER TABLE conversation_history
ADD COLUMN compacted_at TEXT;

ALTER TABLE conversation_history
ADD COLUMN token_estimate INTEGER;

ALTER TABLE conversation_history
ADD COLUMN is_compacted_summary BOOLEAN DEFAULT FALSE;

-- Index for faster filtering
CREATE INDEX idx_conversation_compacted
ON conversation_history(session_id, is_compacted);
```

**Updated Storage Functions:**

```typescript
// Mark messages as compacted
export function markMessagesCompacted(
  jid: string,
  sessionId: string,
  upToIndex: number,
): void;

// Load only uncompacted messages
export function loadUncompactedMessages(
  jid: string,
  sessionId: string,
): ModelMessage[];

// Save message with token estimate
export function saveMessage(
  jid: string,
  sessionId: string,
  message: ModelMessage,
  tokenEstimate?: number,
): void;

// Update tool result with compaction
export function markToolResultCompacted(
  jid: string,
  sessionId: string,
  messageId: number,
): void;
```

---

## Integration Points

### 1. Tool Registry Integration

**Modify:** `src/agent-runner/tool-registry.ts`

Wrap all tool outputs with truncation:

```typescript
// In tool execution:
const result = await tool.execute(args, context);
const truncated = await truncateOutput(result.output, {
  maxLines: 2000,
  maxBytes: 51200,
  direction: 'head',
});

return {
  ...result,
  output: truncated.content,
  _truncated: truncated.truncated,
  _outputPath: truncated.outputPath,
};
```

### 2. Runtime Integration

**Modify:** `src/agent-runner/runtime.ts`

**Pre-flight Check:**

```typescript
async function maybeCompactSessionPreflight(
  input: AgentInput,
  sessionId: string,
  promptText: string,
): Promise<void> {
  const config = getModelConfig(input.modelProvider, input.modelName);
  const threshold = getCompactionThreshold(config);

  // Load uncompacted only
  const messages = loadUncompactedMessages(input.chatJid, sessionId);

  // Estimate tokens
  const estimatedTokens =
    estimateTokenCount(messages) + Math.ceil(promptText.length / 4);

  // Add image estimates if vision model
  let estimatedImageTokens = 0;
  if (config.supportsVision) {
    const imageCount = extractImagePaths(promptText).length;
    estimatedImageTokens = imageCount * 1500;
  }

  const total = estimatedTokens + estimatedImageTokens;

  if (total < threshold) return;

  // Try pruning first
  await pruneToolOutputs(input.chatJid, sessionId);

  // Re-check after pruning
  const prunedMessages = loadUncompactedMessages(input.chatJid, sessionId);
  const newEstimate =
    estimateTokenCount(prunedMessages) +
    Math.ceil(promptText.length / 4) +
    estimatedImageTokens;

  if (newEstimate < threshold) return;

  // Full compaction needed
  await compactSession(input, sessionId);
}
```

**Post-Query Check:**

```typescript
async function maybeCompactSession(
  input: AgentInput,
  sessionId: string,
  usageTokens: number,
): Promise<void> {
  const config = getModelConfig(input.modelProvider, input.modelName);
  const threshold = getCompactionThreshold(config);

  const currentTokens =
    getSessionTokenCount(input.chatJid, sessionId) + usageTokens;

  if (currentTokens < threshold) return;

  await compactSession(input, sessionId);
}
```

**After Response (Pruning):**

```typescript
// In runQuery, after streaming completes:
const result = await runQuery(...);

// Always prune after response
void pruneToolOutputs(input.chatJid, sessionId);
```

### 3. Message Loading

**Modify:** `src/agent-runner/runtime.ts` - `runQuery()`

```typescript
// Load only uncompacted messages for the model
const loadedMessages = loadUncompactedMessages(input.chatJid, sessionId);
messages.push(...loadedMessages);
```

---

## File Structure

```
src/
├── context/
│   ├── index.ts          # Exports
│   ├── truncate.ts       # Tool output truncation
│   ├── token.ts          # Token estimation
│   ├── prune.ts          # Tool output pruning
│   └── filter.ts         # Message filtering
├── agent-runner/
│   ├── session-store.ts  # Updated with compaction columns
│   ├── runtime.ts        # Updated compaction logic
│   └── tool-registry.ts  # Updated with truncation wrapper
└── data/
    └── tool-output/      # Truncated tool outputs
```

---

## Configuration

Add to config:

```typescript
interface ContextConfig {
  truncation: {
    maxLines: number;
    maxBytes: number;
    direction: 'head' | 'tail';
  };
  pruning: {
    protectTokens: number; // 40000
    minimumTokens: number; // 20000
    protectedTools: string[]; // ['skill']
  };
  compaction: {
    thresholdPercent: number; // 60
    archiveEnabled: boolean; // true
    softCompaction: boolean; // true
  };
}
```

---

## Flow Summary

```
User sends message
    ↓
Pre-flight check:
    - Load uncompacted messages
    - Estimate tokens (messages + prompt + images)
    ↓
If exceeds threshold:
    - Run pruning first
    - If still exceeds: compact session
    ↓
streamText() with uncompacted messages
    ↓
Mid-stream monitoring (onFinish):
    - Check usage tokens
    - If overflow: needsCompaction = true
    ↓
After streaming:
    - Save messages with token estimates
    - Run pruning on tool outputs
    ↓
If needsCompaction:
    - Archive to markdown
    - Generate summary of older messages
    - Mark older messages compacted
    - Store summary + recent messages
    ↓
Next turn:
    - filterCompacted() stops at compaction markers
    - Tool outputs show placeholder or full content
```

---

## Testing Checklist

- [ ] Tool output truncation works (2000 lines / 50KB)
- [ ] Truncated files saved to data/tool-output/
- [ ] Token estimation is reasonable (±20%)
- [ ] Pruning runs after each response
- [ ] Pruning protects last 2 user turns
- [ ] Pruning protects "skill" tool
- [ ] Compacted tools show placeholder in LLM context
- [ ] Pre-flight compaction triggers when needed
- [ ] Mid-stream overflow detection works
- [ ] Markdown archive created on compaction
- [ ] Soft compaction marks messages correctly
- [ ] Filtered loading stops at compaction markers
- [ ] Full message history still accessible for UI
