# AGENTS.md - Agent

The CLI application: a TUI client of the Relay server. All agent execution (loop, tools, sessions, approvals, tokens)
happens server-side; the CLI talks to it over the `@vvtxn/client` protocol (REST + SSE). The CLI is the entry point: it
starts (or reuses) a background server before running the TUI.

## Architecture

```
agent/
├── index.ts              # Entry: relay | relay web | serve | stop | status
├── server.ts             # Background-server supervisor (ensureServer/stop/status)
├── open.ts               # openBrowser(url) helper
├── app.tsx               # App component, signals, SSE event folding, command palettes
├── client.ts             # RelayClient singleton (server URL from config/env)
├── config.ts             # RelayConfig: serverUrl (env RELAY_SERVER_URL or ~/.relay/config.json)
├── components/
│   ├── boot-screen.tsx   # BootScreen (loading) and BootError shown while the server is resolved
│   ├── chat.tsx          # MessageView, ToolCallView, DiffView; re-exports shared UIMessage
│   └── status-bar.tsx    # StatusBar, TokenBar (context window arrives from /api/config)
└── hooks/
    └── project-files.ts  # useProjectFiles hook (file listing from the server)
```

### Server supervision (`server.ts`)

`relay` (default) and `relay web` call `ensureServer({ cwd })`:

1. An explicit `RELAY_SERVER_URL` is attached to, never managed.
2. A healthy server recorded in `~/.relay/server.json` is reused.
3. Otherwise a detached server is spawned (compiled: `relay serve`; source: `deno run … server/main.ts`) with
   `RELAY_WORKSPACE=cwd`, and the CLI waits for `/api/health`.

The server writes its own state file (`RELAY_STATE_FILE`) with its PID, port, and web URL; `relay stop` reads it and
signals the process, `relay status` prints it. The server survives the CLI, so the browser stays available.

`relay web` opens the browser (Vite origin in dev when reachable, else the server's bundled SPA) and returns unless
`--foreground` is passed.

## Key Concepts

### Application Structure

`app.tsx` wires together:

- **Relay display utilities** (`@vvtxn/relay/core/display.ts`) — `entriesToUIMessages`, `createUIToolCall`, display
  names/output, diff parsing (pure, shared with the web app)
- **API client** (`./client.ts`, `@vvtxn/client`) — RelayClient + protocol types
- **TUI framework** (`@/tui`) — terminal rendering, components, hooks, input handling
- **Local modules** — config, UI components, project-files hook

The agent runtime is NOT in this package. `runAgentLoop`, tools, providers, and session stores were removed — use
`@vvtxn/server` for the runtime and `@vvtxn/client` for the transport.

### How a Turn Runs

1. `POST /api/sessions/:id/messages` with the raw text (the server expands `@mentions` and persists entries)
2. The per-session SSE stream (subscribed in a `useSignalEffect` keyed by session id) delivers events
3. Events fold through the shared `applyServerEvent` reducer (`@vvtxn/client/session-state.ts`): `text_delta` /
   `tool_call_*` accumulate a draft, `turn_complete` flushes it into `uiMessages`, `run_finished` refetches the session
   so persisted entries are the source of truth. The reducer output is committed to a signal on a 50ms throttle.
4. `message_complete` events carry authoritative token/cost totals

### Approvals

`approval_required` events drive the existing `ApprovalPrompt` hook (`allow`/`always`/`deny`); decisions POST to
`/api/sessions/:id/approve`. `approval_resolved` events (another client answered, or the run ended) cancel the local
ask. Switching sessions denies any pending ask server-side so runs never hang.

### Boot Flow

`index.ts` ensures a server exists (see above), then sets `RELAY_SERVER_URL` before importing `app.tsx`. `bootstrap()`
health-checks it, fetches `/api/me` + `/api/config`, then creates a session for `Deno.cwd()`. `Root` renders
`BootScreen` (loading) or `BootError` (friendly failure) and mounts `App` only once a user, session, and server info
exist. `info.webUrl` powers the "Open in Browser" command.

### Cancellation

Double-Esc (within 1.5s) while a run is active POSTs `/api/sessions/:id/cancel`. The server aborts the run's
AbortController; `run_finished(cancelled)` arrives on the stream like any other event.

### Configuration

- `RELAY_SERVER_URL` env overrides `~/.relay/config.json` `serverUrl` (default `http://127.0.0.1:7433`)
- `config.json` is auto-created with defaults on first run

The LLM API key lives server-side only (`LLM_API_KEY` env or `~/.relay/auth.json` fallback read by the server). The CLI
never prompts for one.

### UI Components

- `Root` — Switches between BootScreen, BootError, and App based on the boot signal
- `App` — Signals, event folding, palettes, approval handling
- `StatusBar` — Model (from server), branch, user, token bar, cost
- `MessageView` / `ToolCallView` / `DiffView` (components/chat.tsx) — Shared display contract from
  `@vvtxn/relay/core/display.ts`; `UIMessage` is re-exported from there (single definition)

## Dependencies

- `@vvtxn/client` — protocol types + RelayClient
- `@vvtxn/server` — the `serve` entry point the supervisor launches
- `@vvtxn/relay` — display utilities only
- `@/tui` — terminal UI framework

## Running

```bash
deno task relay          # start/reuse the server + TUI
deno task relay web      # open the browser client
deno task relay stop     # stop the background server
deno task relay status   # show the background server
```

The compiled binary uses the same commands: `relay`, `relay web`, `relay serve`, `relay stop`, `relay status`.

## Task Completion Checklist

After concluding that a task is complete, always run these commands from the repo root:

1. `deno task fmt` — auto-format all code
2. `deno task lint` — check for lint errors
3. `deno task check` — strict type-check of every entrypoint
4. `deno task test` — run the test suite

## Code Patterns

- Business logic lives server-side; this package only folds events into UI state
- Use signals for reactive UI updates; register the approval hook before the double-Esc handler
- Session switching resets signals and lets the session `useSignalEffect` re-subscribe + refetch
- `@mention` file listing comes from `useProjectFiles` (server endpoint), keyed per session
- `entriesToUIMessages` renders persisted sessions — do not duplicate the conversion locally
