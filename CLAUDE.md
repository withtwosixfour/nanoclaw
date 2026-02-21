# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp and runs the Claude Agent SDK in-process. Groups share the host filesystem, with per-group sessions in SQLite.

## Key Files

| File                          | Purpose                                             |
| ----------------------------- | --------------------------------------------------- |
| `src/index.ts`                | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts`    | WhatsApp connection, auth, send/receive             |
| `src/agent-runner/runtime.ts` | Host agent runtime (streaming, tools, live piping)  |
| `src/router.ts`               | Message formatting and outbound routing             |
| `src/config.ts`               | Trigger pattern, paths, intervals                   |
| `src/task-scheduler.ts`       | Runs scheduled tasks                                |
| `src/db.ts`                   | SQLite operations                                   |
| `groups/{name}/CLAUDE.md`     | Per-group memory (isolated)                         |
| `groups/{name}/.nanoclaw/`    | Per-group conversation store                        |

## Skills

| Skill        | When to Use                                                    |
| ------------ | -------------------------------------------------------------- |
| `/setup`     | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior               |
| `/debug`     | Runtime issues, logs, troubleshooting                          |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
```

Service management:

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Notes

The agent now runs directly on the host process. Be mindful of filesystem access in tools.
