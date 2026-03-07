# Voice Bridge Spec

## Goal

Add a platform-agnostic realtime voice bridge for NanoClaw that supports:

- Discord voice calls and existing voice channels
- Slack Huddles, both direct and invited into existing huddles
- `gpt-realtime` as the live speech engine
- existing NanoClaw agents, prompts, routing, tools, and memory

The voice system should mirror the architectural role of the current Chat SDK text layer: platform-specific adapters at the edge, shared routing/prompt/tool logic in the core.

## Non-Goals

- PSTN or phone-number-first calling
- Replacing the current text Chat SDK flow
- Reusing the text `streamText()` loop for live audio
- Building live WhatsApp voice calling

## Core Principles

- Keep platform media quirks in adapters, not in agent logic
- Reuse current route resolution and agent prompt loading where possible
- Treat voice as a sibling subsystem to text, not a special text message type
- Keep route identity stable and explicit
- Allow direct-call and join-existing-call flows on both supported platforms

## Existing Reuse Points

### Route Resolution

Current route resolution lives in `src/router.ts`.

- `resolveAgentId(threadId)` maps route patterns to `agentId`
- `getRouteInfo(threadId)` provides route context
- wildcard matching already exists and should be reused for voice

### Agent Prompt Loading

Current prompt loading lives in `src/agent-runner/runtime.ts`.

- `buildSystemPrompt(agentId, isMain)` loads `agents/<agentId>/CLAUDE.md`
- non-main agents also receive `agents/global/CLAUDE.md`

Voice sessions should use the same prompt source of truth.

### Tool Exposure

Current tool exposure lives in `src/agent-runner/tool-registry.ts`.

- voice should reuse the same NanoClaw tools where feasible
- realtime sessions should call into a tool bridge backed by the existing registry model

### Session Persistence

Current session mapping and conversation state already exist in:

- `src/db.ts`
- `src/agent-runner/session-store.ts`

Voice should keep its own session identity, but may optionally link to an existing text thread/session for shared memory.

## High-Level Architecture

Add a new subsystem:

```text
src/
  voice-bridge/
    core/
      session-manager.ts
      route-resolver.ts
      prompt-loader.ts
      identity.ts
      policy.ts
    adapters/
      discord.ts
      slack-huddles.ts
    realtime/
      openai.ts
      nanoclaw-tools.ts
    store/
      call-state.ts
      transcript.ts
```

Responsibilities:

- `adapters/*`: platform session control, audio input/output, participant events
- `core/route-resolver.ts`: map voice route keys to `agentId`
- `core/prompt-loader.ts`: load agent prompt files using current semantics
- `realtime/openai.ts`: manage `gpt-realtime` sessions
- `realtime/nanoclaw-tools.ts`: expose NanoClaw tools to the realtime model
- `store/*`: persist active call state, route bindings, summaries, and transcripts

## Voice Route Model

Voice routes must be namespaced separately from text routes.

Examples:

- `voice:discord:guildId:channelId`
- `voice:discord:dm:userId`
- `voice:slack:teamId:channelId:huddleId`
- `voice:slack:dm:userId`

These route keys are used to resolve the agent for a call.

### Why Separate Voice Namespaces

- avoids collisions with existing `discord:*` and `slack:*` text routes
- keeps routing behavior predictable
- allows voice-specific wildcard rules
- avoids breaking assumptions in text-thread parsing logic

### Matching Rules

Reuse the current route priority model from `src/router.ts`:

1. exact match
2. short-form match where appropriate
3. wildcard match, highest specificity first

Example patterns:

- `voice:discord:* -> main`
- `voice:discord:guild123:* -> ops-agent`
- `voice:discord:dm:* -> personal-agent`
- `voice:slack:team456:* -> support-agent`
- `voice:slack:dm:* -> main`

## Agent-to-Call Mapping

When a call or huddle starts:

1. build a stable `routeKey`
2. resolve `agentId` from that route key
3. load prompt content for that agent
4. snapshot the effective prompt into the call session
5. create a `gpt-realtime` session configured with that prompt and tool set

This ensures a call always speaks as a specific NanoClaw agent with the correct system prompt.

### Prompt Assembly

For parity with text behavior, the effective voice system prompt should include:

- route context
- `agents/<agentId>/CLAUDE.md`
- `agents/global/CLAUDE.md` for non-main agents
- optional voice-mode instructions, such as:
  - speak conversationally
  - keep answers short unless asked for more
  - announce tool-use results naturally
  - interrupt cleanly when the user starts speaking

The voice-mode additions should be appended by the voice bridge, not added directly to every agent prompt file.

## Voice Session Model

Each active call should persist a session record with at least:

- `voiceSessionId`
- `platform`
- `platformSessionId`
- `routeKey`
- `agentId`
- `effectivePrompt`
- `participants`
- `startedBy`
- `startedAt`
- `status`
- `linkedTextThreadId` optional
- `linkedTextSessionId` optional

This record allows:

- stable agent identity during a call
- reconnect/recovery logic
- transcript and summary generation
- handoff between live voice and follow-up text flows

## Platform Adapter Interface

Each platform adapter should satisfy a shared contract.

```ts
type VoicePlatform = 'discord' | 'slack';

type VoiceEvent =
  | { type: 'session.started'; sessionId: string; platform: VoicePlatform }
  | {
      type: 'participant.joined';
      sessionId: string;
      participantId: string;
      displayName: string;
    }
  | {
      type: 'participant.left';
      sessionId: string;
      participantId: string;
    }
  | {
      type: 'audio.input';
      sessionId: string;
      participantId: string;
      pcm16: Buffer;
      sampleRate: number;
    }
  | {
      type: 'speech.started';
      sessionId: string;
      participantId: string;
    }
  | {
      type: 'speech.stopped';
      sessionId: string;
      participantId: string;
    }
  | { type: 'session.ended'; sessionId: string; reason?: string };

interface VoicePlatformAdapter {
  connect(): Promise<void>;
  startDirectSession(targetId: string): Promise<{ sessionId: string }>;
  joinExistingSession(targetId: string): Promise<{ sessionId: string }>;
  stopSession(sessionId: string): Promise<void>;
  sendAudio(
    sessionId: string,
    pcm16: Buffer,
    sampleRate: number,
  ): Promise<void>;
  interruptOutput(sessionId: string): Promise<void>;
  onEvent(handler: (event: VoiceEvent) => void): void;
}
```

## OpenAI Realtime Integration

`gpt-realtime` is the live speech engine.

Responsibilities:

- create and manage realtime sessions
- stream inbound audio from platform adapters
- stream outbound model audio back to adapters
- surface tool calls and tool results
- handle interruption, barge-in, and turn-taking

The voice bridge should not run the main conversation through the current text `streamText()` path in `src/agent-runner/runtime.ts`.

Instead:

- `gpt-realtime` handles live conversational audio
- NanoClaw continues to own tools, prompts, routing, memory, and post-call summarization

## NanoClaw Tool Bridge

The realtime bridge should expose NanoClaw tools through a wrapper layer.

Expected behavior:

- tool definitions are derived from the existing tool registry model
- tool calls execute in NanoClaw space, not in adapter code
- tool results are returned to the realtime session in a compact, spoken-friendly format

Examples:

- send a follow-up text message to a linked text thread
- schedule a task
- search local repo context
- invoke web tools where already supported

Tool responses should be optimized for live voice use:

- concise by default
- no raw giant blobs
- natural spoken summaries when appropriate

## Linked Voice/Text Memory

Voice and text should remain separate identities but may be linked.

Recommended model:

- each call gets a dedicated `voiceSessionId`
- optionally attach `linkedTextThreadId`
- after call end, generate:
  - transcript artifact
  - short summary
  - action items if relevant
- optionally inject that summary into the linked text session as context

This preserves clean transport boundaries while allowing continuity.

## Discord Adapter

Discord is the first native adapter and the reference implementation.

### Supported UX

- call the bot directly where supported by the platform surface
- ask the bot to join an existing voice channel/call
- keep the bot in a voice room for ongoing conversation

### Behavior

- route identity should derive from guild/channel context or DM context
- participant join/leave events should update live session state
- user speech should interrupt bot playback cleanly
- adapter should support explicit leave/disconnect handling

### Activation Policy

In shared calls, do not respond to every ambient utterance by default.

Recommended v1 policy:

- respond when directly addressed by name/wake word
- optionally respond when explicitly invited into the call
- allow per-room config later

## Slack Huddles Adapter

Target UX:

- huddle directly with the bot
- invite the bot into an existing huddle

Implementation assumption:

- use a stable meeting-bot or huddles transport layer if Slack native APIs do not provide reliable raw live media access

This is acceptable so long as:

- the adapter preserves the Slack user experience
- the rest of the voice bridge remains platform-agnostic
- no Slack-specific assumptions leak into the core

### Behavior

- route identity should derive from workspace/channel/huddle context or DM context
- join/leave and speaker events should normalize into the shared adapter contract
- direct huddles and invited-into-huddle flows should resolve to the same voice core behavior

## Voice Policies

The bridge should centralize conversation policy separate from prompts.

Initial policies:

- interruption on user speech start
- short conversational responses by default
- avoid talking over users
- configurable activation rules for multi-user rooms
- inactivity timeout and auto-leave
- graceful fallback to text when voice transport fails

## Data Model Additions

Likely new tables or equivalent storage:

- `voice_routes`
  - `route_key`
  - `agent_id`
  - optional metadata
- `voice_sessions`
  - session and platform identifiers
  - agent mapping
  - timing and status
  - linked text references
- `voice_participants`
  - current and historical participant membership
- `voice_transcripts`
  - utterance or chunk records
- `voice_summaries`
  - post-call summary and follow-up context

If route reuse is preferred, `voice:*` keys can live in the existing route table instead of requiring a dedicated `voice_routes` table.

## Integration With Existing App Entry Point

Best integration seam is next to the current Chat SDK composition layer in `src/chat-sdk-bot.ts`.

Recommended approach:

- keep text adapter setup as-is
- initialize voice bridge alongside text adapters
- share route, agent, and persistence dependencies
- avoid mixing voice transport into existing message reaction and text-ack logic

The voice bridge should be started from the same high-level app bootstrap, but should own its own lifecycle.

## Failure Modes And Fallbacks

Required fallbacks:

- no voice route configured -> reject or reply with setup guidance
- no stable Slack media transport -> degrade to text or disabled state
- realtime session failure -> notify users and end the call cleanly
- tool execution too slow -> model acknowledges and follows up when ready
- adapter disconnect -> attempt bounded reconnect, then fail closed

## Security And Safety

- keep tool execution inside existing NanoClaw permission boundaries
- do not expose raw platform tokens to the model
- log call lifecycle separately from text messages
- keep transcripts and summaries opt-in or policy-controlled where necessary
- avoid always-on ambient response in shared rooms by default

## Implementation Phases

### Phase 1: Core Voice Foundations

- add `voice:*` route-key model
- implement prompt loader reusing current prompt semantics
- define session record and store layer
- implement policy layer

### Phase 2: Realtime Engine

- add `gpt-realtime` session manager
- bridge audio input/output
- add NanoClaw tool wrapper for realtime tool calls

### Phase 3: Discord Adapter

- native Discord voice transport
- direct-call and join-existing-call flows
- barge-in and activation rules

### Phase 4: Slack Huddles Adapter

- huddles transport integration
- direct huddle and invite-to-huddle support
- normalize events into shared contract

### Phase 5: Linked Memory And Post-Call Work

- transcript storage
- post-call summaries
- optional linked text-thread continuation

### Phase 6: Controls And Admin UX

- room-level config
- per-agent voice defaults
- activation policy tuning
- observability and debugging tools

## Recommended v1 Scope

- build the shared voice bridge core first
- make Discord the first full adapter
- keep Slack behind the same interface and ship once transport is stable
- use `gpt-realtime` for live speech
- keep NanoClaw as the routing, prompt, tools, and memory layer

## Open Questions

- whether voice route keys should share the existing route table or use a dedicated one
- whether direct-call identities should map to DM-style voice keys or synthetic room keys
- how much transcript detail should be persisted by default
- whether linked text summaries should be automatic or opt-in per room

## Final Recommendation

Treat voice as a first-class transport layer inside NanoClaw:

- Chat SDK remains the text transport abstraction
- Voice Bridge becomes the live-audio transport abstraction
- `gpt-realtime` is the realtime speech engine
- NanoClaw remains the source of truth for agent identity, prompts, tools, memory, and routing

This keeps the system platform-agnostic, aligned with the current architecture, and capable of supporting both Discord and Slack without turning live voice into a fragile text-only hack.
