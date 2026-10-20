# AGENTS.md - Agent

The CLI application: a TUI client of the Relay server. All agent execution (loop, tools, sessions, approvals, tokens)
happens server-side; the CLI talks to it over the `@vvtxn/client` protocol (REST + SSE). The CLI is the entry point: it
starts (or reuses) a background server before running the TUI.

## Architecture

```
agent/
├── index.ts              # Entry: relay [-c|--workspace] | relay web | serve | stop | status | fonts | workspace
├── server.ts             # Background-server supervisor (ensureServer/stop/status) + auth + API-key gates
├── open.ts               # openBrowser(url) helper
├── workspace.ts          # relay workspace add|list|remove (register without the TUI)
├── fonts.ts              # relay fonts install|status|path (shared font for the terminal)
├── app.tsx               # App component, signals, SSE event folding, command palettes
├── client.ts             # RelayClient singleton (server URL from config/env)
├── config.ts             # RelayConfig: serverUrl (env RELAY_SERVER_URL or ~/.relay/config.json)
├── diffs.ts              # Session diff collection + preview/viewer row building (pure)
├── tool-display.ts       # Shared tool-call colors and label column width
├── components/
│   ├── boot-screen.tsx   # BootScreen (loading) and BootError shown while the server is resolved
│   ├── chat.tsx          # MessageView (user/agent turns, tool rows, inline diff previews)
│   ├── diff.tsx          # Compact DiffPreview + full-screen DiffViewer overlay
│   └── status-bar.tsx    # StatusBar (branch + accumulated cost)
└── hooks/
    └── project-files.ts  # useProjectFiles hook (file listing from the server)
```

### Server supervision (`server.ts`)

`relay` (default) and `relay web` call `ensureServer({ cwd })`:

1. An explicit `RELAY_SERVER_URL` is attached to, never managed.
2. A healthy server recorded in `~/.relay/server.json` is reused.
3. A healthy server answering on the preferred port is adopted even without a state file (e.g. a foreground
   `relay serve`).
4. Otherwise a detached server is spawned (`node packages/server/main.ts`) with
   `RELAY_WORKSPACE=cwd` and `RELAY_PORT` (explicit, else the default 7433 — never derived from `RELAY_PUBLIC_URL`).

The state file is the source of truth for the actual URL: the server writes it after binding, and the CLI discovers the
port from it instead of assuming its own choice. The CLI waits until the server is healthy, the child exits (the error
includes the server-log tail), or the timeout (120s, `RELAY_START_TIMEOUT_MS`) elapses. When the port is taken by
something that is not a healthy Relay server, development starts a fallback server on a free port; production or an
explicit `RELAY_PORT` fails with the bind error. `relay stop` reads the state file and signals the recorded process;
`relay status` prints it. The server survives the CLI, so the browser stays available.

`relay web` opens the browser at the current (or `--workspace`) directory's workspace route (Vite origin in dev when
reachable, else the server's bundled SPA) and returns unless `--foreground` is passed.

## Key Concepts

### Application Structure

`app.tsx` wires together:

- **Relay display utilities** (`@vvtxn/relay/core/display.ts`) — `entriesToUIMessages`, `createUIToolCall`, display
  names/output, diff parsing (pure, shared with the web app)
- **API client** (`./client.ts`, `@vvtxn/client`) — RelayClient + protocol types
- **TUI framework** (`#/tui`) — terminal rendering, components, hooks, input handling
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

### Diffs

Edit/write tool results arrive with a unified diff on `UIToolCall.diff` (live from `tool_result` and from persisted
`tool_result` entries), so the terminal needs no server or protocol changes to render changes.

- Each grouped edit/write row shows a compact preview underneath: changed lines only, hunk separators, line numbers,
  tabs expanded to four spaces, and `+`/`−` in the shared success/error tokens. Previews cap at 3 files per group and
  8 changed lines per file; the remainder is summarized as `… N more changed lines · ctrl+o`.
- `ctrl+o` opens `DiffViewer` for the most recent diff; `n`/`p` cycle every diff in the session, arrows/PgUp/PgDn/wheel
  scroll, and Esc/`q` close it. `/` → **Review Changes** opens the same overlay. The overlay keeps full context and
  `@@` headers, unlike the transcript preview.
- The open diff list, position, and pre-built full-context rows live in an app-level signal **by value**, so streamed
  deltas behind the overlay cannot close or re-parse it. `DiffBody` is memoized; the app re-renders on every stream
  commit, but the diff rows themselves are not rebuilt.
- Key registration order matters: approvals first, command palettes next (an open palette owns ctrl+o), the diff viewer
  next (Escape closes it instead of priming cancellation), then the double-Esc cancel handler. While the overlay is
  open the composer and chat `ScrollArea` are unfocused, and every non-navigation key is swallowed.
- `diffs.ts` is pure: `collectSessionDiffs()` folds messages into reviewable diffs and `buildDiffRows()` produces
  compact or full-context rows. Both are unit-tested; the shared `parseDiff()`/`diffStats()` live in
  `@vvtxn/relay/core/display.ts`.

### Approvals

`approval_required` events drive the existing `ApprovalPrompt` hook (`allow`/`always`/`deny`); decisions POST to
`/api/sessions/:id/approve`. `approval_resolved` events (another client answered, or the run ended) cancel the local
ask. Switching sessions denies any pending ask server-side so runs never hang.

### Boot Flow

`index.ts` parses `-c`/`--continue` and `--workspace <path>` (the default command's flags), ensures a server exists
(see above), then sets `RELAY_SERVER_URL` before importing `app.tsx`. It then checks `/api/me` (using the token handed
over by a browser login in `~/.relay/session.json`). Local mode resolves the local identity without a token, so this
passes immediately; GitHub mode opens the web client and waits for the sign-in to complete (`ensureAuthenticated`).
`--workspace` is validated and registered server-side at this point; the server's
canonical path becomes `RELAY_CLI_WORKSPACE`. It then checks `/api/settings` — if no LLM API key is configured it opens
the web Settings page and waits (`ensureApiKey`), so the TUI never starts in an unusable state. `bootstrap()` then
health-checks the server, fetches `/api/me` + `/api/config`, and resolves the initial session for the effective
workspace (`config.ts` `workspaceCwd()`): `--continue` resumes the most recent thread, otherwise a session is created
(the server reuses an idle empty one, so repeated launches do not pile up blank threads).
`Root` renders `BootScreen` (loading) or `BootError` (friendly failure) and mounts `App` only once a user, session, and
server info exist. `info.webUrl` powers the "Open in Browser" command.

### Workspace scoping

The TUI is scoped to one workspace for its lifetime: the launch directory, or the `--workspace` target. Session
creation, "New Chat", and the `/threads` palette all use that cwd, so a terminal in a project only ever shows that
project's threads. `relay web` opens the browser at the same workspace's route (`/w/<token>` from the shared
`workspace-token.ts` encoder); `relay workspace add|list|remove` manages registrations separately, and `remove` hides
(tombstones) a workspace without deleting its sessions.

### Cancellation

Double-Esc (within 1.5s) while a run is active POSTs `/api/sessions/:id/cancel`. The server aborts the run's
AbortController; `run_finished(cancelled)` arrives on the stream like any other event.

### Configuration

- `RELAY_SERVER_URL` env overrides `~/.relay/config.json` `serverUrl` (default `http://127.0.0.1:7433`)
- `config.json` is auto-created with defaults on first run

The LLM API key is stored per user, encrypted at rest (local files by default), and set from the web app's Settings
page. The CLI never prompts for one: at startup (`ensureApiKey`) it opens the Settings page and waits until a key is
saved, so the TUI cannot start without one.

### UI Components

- `Root` — Switches between BootScreen, BootError, and App based on the boot signal
- `App` — Signals, event folding, palettes, approval handling; while a thread's history loads it shows a "Loading
  thread…" hint instead of the welcome screen (`loadingSession` signal). The composer's top border carries the vim mode
  label (`borderLabel`, rendered as `╭─ INSERT ─────╮` / `╭─ NORMAL ─────╮`), and the bottom-left status line shows the
  running agent status (spinner + `Thinking…`/`Writing…`/`Running <tool>…`, plus the Esc-to-cancel hint), falling back
  to the input hints when idle
- `StatusBar` — Branch and accumulated session cost
- `DiffPreview` / `DiffViewer` (components/diff.tsx) — Compact changed-lines-only preview under edit/write groups, and
  the full-context scrollable review overlay. Both render ANSI-styled rows from the pure helpers in `diffs.ts`; the
  preview is memoized so streamed deltas skip unchanged diffs
- `MessageView` (components/chat.tsx) — Shared display contract from `@vvtxn/relay/core/display.ts`; `UIMessage` is
  re-exported from there (single definition). User turns sit on a full-width `surfaceElevated` band, agent turns are
  marked with a `●` (brand), and turns are separated by the scroll gap. Tool calls
  are grouped per tool by `groupToolCalls()` into compact rows — per-tool accent on the name, the targets it touched,
  and a right-aligned result stat — instead of a row per call, with inline diff previews under edit/write groups.
  Wrapped in `memo()` (pure function of props) so idle frames and streamed deltas skip re-rendering unchanged messages

### Fonts (`fonts.ts`)

A terminal owns its font, so the CLI cannot load one at runtime. `relay fonts install` copies the ttf/otf files from
`@vvtxn/relay/assets/fonts` (resolved relative to the CLI bundle, which sits at the same depth as the source) into the
platform user font directory (`~/.local/share/fonts`, `~/Library/Fonts`, `%LOCALAPPDATA%\Microsoft\Windows\Fonts`),
refreshes fontconfig on Linux, and prints the family to select in the terminal settings. `status` reports which files are
installed; `path` prints the bundled directory. The web client loads the same font automatically, so both clients render
the same typeface.

## Dependencies

- `@vvtxn/client` — protocol types + RelayClient
- `@vvtxn/server` — the `serve` entry point the supervisor launches
- `@vvtxn/relay` — display utilities, theme tokens, and the shared font manifest
- `#/tui` — terminal UI framework

## Running

```bash
pnpm relay           # start/reuse the server + TUI in the current directory
pnpm relay -c        # ...resuming the most recent thread for the directory
pnpm relay --workspace ~/Code/foo  # ...scoped to another registered directory
pnpm relay web       # open the browser client at the current workspace
pnpm relay web --workspace ~/Code/foo  # ...at another directory's workspace
pnpm relay stop      # stop the background server
pnpm relay status    # show the background server
pnpm relay workspace add ~/Code/foo  # register a workspace (no TUI)
pnpm relay workspace list            # list registered workspaces
pnpm relay fonts status  # check whether the shared font is installed
```

`scripts/relay.ts` decides the entrypoint: non-TUI subcommands (`serve`, `web`, `stop`, `status`, `workspace`,
`fonts`) run `packages/cli/agent/index.ts` straight from source under Node's native TypeScript support — no bundle
build — while the TUI command packs `packages/cli` (`vp pack`, JSX needs compilation) and runs
`packages/cli/dist/index.mjs`. Both paths use the same commands: `relay [-c|--workspace]`, `relay web`, `relay serve`,
`relay stop`, `relay status`, `relay workspace add|list|remove`, `relay fonts`.

## Task Completion Checklist

After concluding that a task is complete, always run these commands from the repo root:

1. `pnpm exec vp fmt` — auto-format all code
2. `pnpm check` — format, lint, and type-check (Oxfmt, Oxlint, tsgo via Vite+)

## Code Patterns

- Business logic lives server-side; this package only folds events into UI state
- Use signals for reactive UI updates; register the approval hook before the double-Esc handler
- Session switching resets signals and lets the session `useSignalEffect` re-subscribe + refetch
- `@mention` file listing comes from `useProjectFiles` (server endpoint), keyed per session
- `entriesToUIMessages` renders persisted sessions — do not duplicate the conversion locally
- Keep chat views pure and `memo()`-wrapped; message objects keep identity across streamed deltas, which is what makes
  idle frames and deltas skip unchanged messages
- Diff presentation is pure and testable (`diffs.ts`); render it through `DiffPreview`/`DiffViewer` instead of stuffing
  raw patches into `Markdown` (which would show every context line and bypass the preview cap)
- A global key handler that should win over run cancellation must be registered before the double-Esc handler; one that
  should lose to an open palette must be registered after the palette hooks
