# NanoClaw Command Spec

## Scope

Add two text commands handled directly by NanoClaw:

- `/clear` resets the current group's session.
- `/status` returns session stats for the current group.

Commands are processed as standalone messages and do not require the trigger word.

## Command Behavior

### `/clear`

Purpose: Start a fresh conversation for the current group without deleting history.

Actions:

- Delete `groups/<group>/.nanoclaw/session.json` if it exists.
- Do not modify `groups/<group>/.nanoclaw/conversation.db`.

Result message:

- `Session cleared. New conversation will start on next message.`

Notes:

- Applies only to the group that sent the command.
- Allowed from any group member.

### `/status`

Purpose: Show current session stats for the group.

Data sources:

- `groups/<group>/.nanoclaw/session.json` (session id via `getOrCreateSessionId`).
- `groups/<group>/.nanoclaw/conversation.db` (current session messages + tokens).

Fields:

- `group`: group folder name
- `session`: current session id
- `messages`: count of messages in current session
- `tokens`: token count for current session
- `last`: most recent message timestamp (ISO 8601) or `none`

Example:

`Status: group=main session=... messages=42 tokens=10234 last=2026-02-21T18:02:11.123Z`

Notes:

- Allowed from any group member.

## Command Parsing

- Match the entire trimmed message (case-insensitive): `/clear` or `/status`.
- Ignore inline use (additional text after the command).
- When a command is handled, skip trigger matching and agent invocation.

## Implementation Constraints

- Reuse `src/agent-runner/session-store.ts` for session id and token counts.
- Add a small helper to delete `session.json` for a group.
- No DB schema changes.

## Tests (minimal)

- `/clear` removes `session.json` and forces a new session id on next access.
- `/status` returns expected fields for empty and populated sessions.

## Docs

- Add `/clear` and `/status` to `README.md` command list.
