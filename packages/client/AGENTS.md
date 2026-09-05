# AGENTS.md - Client

Typed wire protocol + HTTP/SSE client shared by every Relay frontend (CLI in Deno, web app in the browser).

## Architecture

```
client/
├── deno.json        # @vvtxn/client, no runtime deps beyond @vvtxn/relay types
├── mod.ts           # Public exports
├── protocol.ts      # REST payloads + ServerEvent union (plain JSON types only)
├── sse.ts           # readSSEStream (fetch-based parser), encodeSSEFrame (server side)
├── client.ts        # RelayClient + RelayApiError
└── client.test.ts   # Protocol + client tests (mock fetch)
```

## Key Concepts

### Protocol (`protocol.ts`)

The single source of truth for the server↔client contract. All types are plain JSON so any runtime can consume them.
REST payloads cover health, identity, workspace, sessions CRUD, files, and approvals. `ServerEvent` mirrors the agent
runner callbacks 1:1 plus server lifecycle events (`run_state` snapshot, `approval_required/resolved`, `run_finished`).

### SSE (`sse.ts`)

- `readSSEStream<T>(response)` — parses `data: {json}\n\n` frames from a fetch Response into an async iterable.
  Deliberately not EventSource-based so Deno and browsers share one implementation. Stops at `data: [DONE]`, skips
  malformed frames, tolerates SSE comments (heartbeats).
- `encodeSSEFrame(data)` — server-side encoder for the same framing.

### RelayClient (`client.ts`)

Pure fetch. Methods map 1:1 to endpoints. `subscribe(sessionId, { signal, onOpen })` yields `ServerEvent`s; `onOpen`
fires when the stream response is established (clients use it to know events can flow). Non-2xx responses throw
`RelayApiError` with the server's `error` message and status.

## Dependencies

- `@vvtxn/relay` — type-only imports (Entry, SessionSummary, ToolResult, Usage)
- No npm/jsr runtime dependencies

## Task Completion Checklist

After concluding that a task is complete, always run these commands from the repo root:

1. `deno task fmt` — auto-format all code
2. `deno task lint` — check for lint errors
3. `deno task test` — run the test suite

## Code Patterns

- Protocol changes always land here first; server and both clients consume the same types
- Keep protocol types JSON-serializable (no class instances, no functions)
- Error bodies always use `{ error: string }` so clients can render them directly
- New endpoints: add payload types to `protocol.ts`, a method to `RelayClient`, tests in `client.test.ts`
