# AGENTS.md - Client

Typed wire protocol + HTTP/SSE client used by the Relay terminal client (CLI in Node).

## Architecture

```
client/
├── package.json        # @vvtxn/client, relay display + theme deps, #/ imports
├── mod.ts              # Public exports
├── protocol.ts         # REST payloads + ServerEvent union (plain JSON types only)
├── sse.ts              # readSSEStream (fetch-based parser), encodeSSEFrame (server side)
├── client.ts           # RelayClient + RelayApiError
├── services.ts         # Effect layer over RelayClient (Api + SessionStream, RelayError)
└── session-state.ts    # Pure ServerEvent fold reducer shared by all clients
```

## Key Concepts

### Protocol (`protocol.ts`)

The single source of truth for the server↔client contract. All types are plain JSON so any runtime can consume them.
REST payloads cover health, auth info, identity (`MeResponse` includes an optional `avatarUrl`), per-user settings
(`SettingsResponse` carries only `{ set, hint }` for the stored API key), workspace, sessions CRUD, files, and
approvals. `ServerEvent` mirrors the agent runner callbacks 1:1 plus server lifecycle events (`run_state` snapshot,
`approval_required/resolved`, `run_finished`).

### SSE (`sse.ts`)

- `readSSEStream<T>(response)` — parses `data: {json}\n\n` frames from a fetch Response into an async iterable.
  Deliberately not EventSource-based so Node and browsers share one implementation. Stops at `data: [DONE]`, skips
  malformed frames, tolerates SSE comments (heartbeats).
- `encodeSSEFrame(data)` — server-side encoder for the same framing.

### RelayClient (`client.ts`)

Pure fetch. Methods map 1:1 to endpoints. `subscribe(sessionId, { signal, onOpen })` yields `ServerEvent`s; `onOpen`
fires when the stream response is established (clients use it to know events can flow). Non-2xx responses throw
`RelayApiError` with the server's `error` message and status.

### Effect service layer (`services.ts`)

`ApiLive(client)` wraps a configured `RelayClient` in the `Api` service (REST as `Effect<A, RelayError>`);
`SessionStreamLive` adds the SSE subscription as `Stream<ServerEvent, RelayError>`. `appLayer(client)` provides both,
and `RelayError`/`isUnauthorized` are the shared failure vocabulary. The transport below it stays Promise-based on
purpose: environments without an Effect runtime (the TUI bundle) use `RelayClient` directly.

Tests for this module live in `test/services.test.ts` and run under Node (`pnpm exec vp test`).

### Session state (`session-state.ts`)

The shared event fold: `applyServerEvent(state, event)` is a pure reducer over `ServerEvent` producing display-ready
state (draft text, tool calls, running flag, status, tokens/cost, pending approval). `viewMessages()` merges the
in-flight draft into the message list, and `flushDraft()` finalizes it. Both the CLI and web clients hold this state in
their own reactive primitive, so their run rendering can never drift.

## Dependencies

- `@vvtxn/relay` — protocol types (type-only) and `display.ts` runtime helpers used by the fold reducer
- `effect` (v4) — only in `services.ts`; the protocol, transport, and reducer stay Effect-free

## Task Completion Checklist

After concluding that a task is complete, always run these commands from the repo root:

1. `pnpm exec vp fmt` — auto-format all code
2. `pnpm check` — format, lint, and type-check (Oxfmt, Oxlint, tsgo via Vite+)
3. `pnpm exec vp test` — run the test suites

## Code Patterns

- Protocol changes always land here first; server and client consume the same types
- Keep protocol types JSON-serializable (no class instances, no functions)
- Error bodies always use `{ error: string }` so clients can render them directly
- New endpoints: add payload types to `protocol.ts` and a method to `RelayClient`
