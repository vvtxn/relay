# AGENTS.md - Agent

The CLI application: a TUI client of the Relay server. All agent execution (loop, tools, sessions, boxes, tokens)
happens server-side; the CLI talks to it over the `@vvtxn/client` protocol (REST + SSE). The CLI is the entry point: it
starts (or reuses) a background server before running the TUI.

## Architecture

```
agent/
├── index.ts              # Entry: relay [-c|--workspace] | relay web | serve | stop | status | fonts | workspace
├── server.ts             # Background-server supervisor (ensureServer/stop/status) + auth + API-key gates
├── open.ts               # openBrowser(url) helper
├── workspace.ts          # relay workspace add|list|remove (register without the TUI)
├── threads.ts            # relay threads / relay attach (multi-client discovery)
├── fonts.ts              # relay fonts install|status|path (shared font for the terminal)
├── app.tsx               # App component, signals, SSE event folding, command palettes
├── client.ts             # RelayClient singleton (server URL from config/env)
├── config.ts             # RelayConfig: serverUrl + theme mode (env RELAY_SERVER_URL / RELAY_THEME or ~/.relay/config.json)
├── theme.ts              # Palette preference → terminal query → derived theme, applied before app.tsx loads
├── diffs.ts              # Session diff collection (pure); row building is shared in relay display
├── tool-bundle.ts        # Folds tool calls from consecutive agent turns into collapsible transcript bundles (pure)
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
2. A healthy server recorded in the mode's state file (`~/.relay/server-local.json` or `server-cloud.json`) is reused.
3. A healthy server answering on the preferred port is adopted even without a state file (e.g. a foreground
   `relay serve`).
4. Otherwise a detached server is spawned (`node packages/server/entry.ts`) with
   `RELAY_WORKSPACE=cwd` and `RELAY_PORT` (explicit, else the default 7433 — never derived from `RELAY_PUBLIC_URL`).

The state file is the source of truth for the actual URL: the server writes it after binding, and the CLI discovers the
port from it instead of assuming its own choice. The CLI waits until the server is healthy, the child exits (the error
includes the server-log tail), or the timeout (120s, `RELAY_START_TIMEOUT_MS`) elapses. The configured port is strict:
when it is taken by something that is not a healthy Relay server, startup fails with the bind error instead of moving to
a random port. `relay stop` reads the state file and signals the recorded process; `relay status` prints it. The server
survives the CLI, so the browser stays available.

`relay web` builds the bundled SPA, opens the browser at the current (or `--workspace`) directory's workspace route on
the server origin, and returns unless `--foreground` is passed.

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

- Expanding a tool bundle shows each edit/write call's compact preview: changed lines only, hunk separators, line
  numbers, tabs expanded to four spaces, and add/remove rows colored from the shared success/error tokens. Change
  prefixes are never printed — the color carries the signal. Previews cap at 8 changed lines per file; the remainder is
  summarized as `… N more changed lines · ctrl+o`.
- `ctrl+o` opens `DiffViewer` for the most recent diff; `n`/`p` cycle every diff in the session, arrows/PgUp/PgDn/wheel
  scroll, and Esc/`q` close it. `/` → **Review Changes** opens the same overlay. The overlay keeps full context and
  `@@` headers, unlike the transcript preview.
- The open diff list, position, and pre-built full-context rows live in an app-level signal **by value**, so streamed
  deltas behind the overlay cannot close or re-parse it. `DiffBody` is memoized; the app re-renders on every stream
  commit, but the diff rows themselves are not rebuilt.
- Key registration order matters: command palettes first (an open palette owns ctrl+o), the diff viewer next (Escape
  closes it instead of priming cancellation), then the double-Esc cancel handler. While the overlay is open the
  composer and chat `ScrollArea` are unfocused, and every non-navigation key is swallowed.
- `diffs.ts` is pure: `collectSessionDiffs()` folds messages into reviewable diffs. Row building
  (`prettyDiff()`, compact or full-context) and the `diffRowToken()` color contract live in
  `@vvtxn/relay/core/diff-view.ts`; `parseDiff()`/`diffStats()` live in `display.ts`. All are shared with the web
  client.

### Boot Flow

`index.ts` parses `-c`/`--continue`, `--workspace <path>`, `--session <id>`, and `--theme <auto|dark|light>` (the
default command's flags), ensures a server exists (see above), then sets `RELAY_SERVER_URL` before importing
`app.tsx`. `relay attach <id>` is
the explicit form: it opens the session, scopes the TUI to its canonical cwd, and sets `RELAY_CLI_SESSION`. It then
checks `/api/me` (using the token handed over by the browser session in `~/.relay/session.json`). Local mode resolves
the local identity without a token, so this passes immediately; GitHub mode opens the web client and waits for the
sign-in to complete (`ensureAuthenticated`).
`--workspace` is validated and registered server-side at this point; the server's
canonical path becomes `RELAY_CLI_WORKSPACE`. It then checks `/api/settings` — if the default selection has no connected
credential it opens the web Settings page and waits (`ensureApiKey`), so the TUI never starts in an unusable state.
`prepareTheme()` then resolves the palette (querying the terminal in `auto` mode), and only afterwards is `app.tsx`
imported. `bootstrap()`
then health-checks the server, fetches `/api/me` + `/api/config`, and resolves the initial session for the effective
workspace (`config.ts` `workspaceCwd()`): an explicit `--session`/`relay attach` target wins, `--continue` resumes the
most recent thread, otherwise a session is created (the server reuses an idle empty one, so repeated launches do not
pile up blank threads). `Root` renders `BootScreen` (loading) or `BootError` (friendly failure) and mounts `App` only
once a user, session, and server info exist. `info.webUrl` powers the "Open in Browser" command.

### Multi-client operation

Relay is designed for several CLI processes attached to one background server. `relay threads [--all]` lists
workspace threads with their run phase and queue position; `relay attach <id>` opens one. Runs continue on the server
when a CLI exits, and another client can attach or watch the same thread. Nodes in the session state now include the
server run phase, box id, and queue position, so the status line can show `Preparing workspace`, `Waiting for box`,
`Starting box`, or `Running`. Multiple viewers are safe: the server keeps a stable live handle for an
active run and does not reset tokens/cost when another client subscribes. Attached sessions report the workspace's
current git branch in the status bar.

### Workspace scoping

The TUI is scoped to one workspace for its lifetime: the launch directory, the `--workspace` target, or the cwd of an
explicitly attached session. Session creation, "New Chat", and the `/threads` palette all use that cwd, so a terminal
in a project only ever shows that project's threads. Multiple CLI processes may attach to different threads of the
same workspace; each keeps its own draft and stream. `relay web` opens the browser at the same workspace's route (`/w/<token>` from the shared
`workspace-token.ts` encoder); `relay workspace add|list|remove` manages registrations separately, and `remove` hides
(tombstones) a workspace without deleting its sessions.

### Cancellation

Double-Esc (within 1.5s) while a run is active POSTs `/api/sessions/:id/cancel`. The server aborts the run's
AbortController; `run_finished(cancelled)` arrives on the stream like any other event.

### Configuration

- `RELAY_SERVER_URL` env overrides `~/.relay/config.json` `serverUrl` (default `http://127.0.0.1:7433`)
- `config.json` is auto-created with defaults on first run
- `RELAY_THEME` env overrides `~/.relay/config.json` `theme` (`auto` default, or `dark`/`light`); `--theme` on `relay`
  and `relay attach` overrides both

### Theming

The CLI palette is a CLI-local copy of the shared tokens (`#/tui/theme.ts`). Before importing `app.tsx`, `theme.ts`
resolves the preference and — in `auto` mode — asks the terminal for its default foreground/background (OSC 10/11) and
its 16 ANSI colors (OSC 4), fenced by DA1 (`tui/core/terminal-palette.ts`). `tui/theme-derive.ts` builds the palette:
neutrals are foreground/background blends, semantic accents use the reported ANSI colors (or ANSI slot names when the
terminal stays silent), and patch rendering uses the derived success/error accents. A terminal that answers nothing
falls back to the built-in dark theme (or light when `COLORFGBG` suggests a light background). The applied palette must
be set before `app.tsx` loads: components capture some tokens at module load and markdown caches parsed segments. Tool
colors are getters so they still track the active object; don't add new module-level token captures.

The LLM API key is stored per user, encrypted at rest (local files by default), and set from the web app's Settings
page. The CLI never prompts for one: at startup (`ensureApiKey`) it opens the Settings page and waits until a key is
saved, so the TUI cannot start without one.

### UI Components

- `Root` — Switches between BootScreen, BootError, and App based on the boot signal
- `App` — Signals, event folding, palettes; while a thread's history loads it shows a "Loading
  thread…" hint instead of the welcome screen (`loadingSession` signal). The composer's top border carries the vim mode
  label (`borderLabel`, rendered as `╭─ INSERT ─────╮` / `╭─ NORMAL ─────╮`), and the bottom-left status line shows the
  running agent status (spinner + `Thinking…`/`Writing…`/`Running <tool>…`, plus the Esc-to-cancel hint), falling back
  to the input hints when idle
- `StatusBar` — Branch, active thread model, and accumulated session cost. The model shown is the thread's sticky
  selection (falling back to the account default from `/api/config`).
- **Model picker** — `ctrl+s` (or `/` → Model) loads `/api/models` and opens a command palette of every connected
  subscription's models. Selecting one sets the thread's sticky `modelSelection` signal; the next `sendMessage` sends it
  with the request. A `model_changed` stream event updates the signal and the transcript.
- `DiffPreview` / `DiffViewer` (components/diff.tsx) — Compact changed-lines-only preview inside an expanded tool
  bundle (edit/write calls), and the full-context scrollable review overlay. Both render ANSI-styled rows from the
  shared `prettyDiff()` in `@vvtxn/relay/core/diff-view.ts`; the preview is memoized so streamed deltas skip unchanged
  diffs
- `MessageView` (components/chat.tsx) — Shared display contract from `@vvtxn/relay/core/display.ts`; `UIMessage` is
  re-exported from there (single definition). Renders prose only: user turns sit on a full-width `surfaceElevated`
  band, agent turns are marked with a `●` (brand), and turns are separated by the scroll gap. Tool calls are not drawn
  here — `bundleTranscript()` pulls them into `ToolBundleView` blocks after the prose.
  Wrapped in `memo()` (pure function of props) so idle frames and streamed deltas skip re-rendering unchanged messages
- `ToolBundleView` (components/chat.tsx) — `bundleTranscript()` (`tool-bundle.ts`) turns every agent turn's tool calls
  into a tool block after its prose and merges adjacent blocks, so `read` → `read` → `write` renders as one collapsed
  `2 reads · 1 write` row. Expanding lists every call chronologically with its target, per-call stat, capped output,
  and edit/write diff preview. User turns and system notices (model switches) end a run (their calls start a new
  bundle); empty agent turns are skipped without splitting it. The bundle's call array is cached per run, so memoized
  expanded bodies skip streamed commits.

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
pnpm relay           # cloud mode (primary): Turso + GitHub
pnpm relay:local     # local self-host: SQLite + local auth
pnpm relay -c        # ...resuming the most recent thread for the directory
pnpm relay --workspace ~/Code/foo  # ...scoped to another registered directory
pnpm relay threads                   # list threads, run phases, and box queue state
pnpm relay threads --all             # ...across every registered workspace
pnpm relay attach <sessionId>        # open the TUI on an existing thread
pnpm relay --session <sessionId>     # ...same, as a default-command flag
pnpm relay --theme light             # ...with a fixed palette (auto|dark|light)
pnpm relay attach <sessionId> --theme dark
pnpm relay web       # open the cloud browser client at the current workspace
pnpm relay:local web # open the local browser client
pnpm relay stop      # stop the cloud background server
pnpm relay:local stop # stop the local background server
pnpm relay status    # show the cloud background server
pnpm relay workspace add ~/Code/foo  # register a workspace (no TUI)
pnpm relay workspace list            # list registered workspaces
pnpm relay fonts status  # check whether the shared font is installed
```

`scripts/relay.ts` decides the entrypoint: source-safe subcommands (`serve`, `web`, `stop`, `status`, `workspace`,
`fonts`, `threads`, `version`) run `packages/cli/agent/index.ts` straight from source under Node's native TypeScript
support, while the TUI and `attach` commands pack `packages/cli` (`vp pack`, JSX needs compilation) and run
`packages/cli/dist/index.mjs`. Commands that serve the app (`relay`, `relay web`, `relay serve`) also build the bundled
web app first; lifecycle-only commands skip both builds. Both paths use the same commands: `relay [-c|--workspace]`,
`relay web`, `relay serve`, `relay stop`, `relay status`, `relay workspace add|list|remove`, `relay fonts`,
`relay threads`, `relay attach`.

## Task Completion Checklist

After concluding that a task is complete, always run these commands from the repo root:

1. `pnpm exec vp fmt` — auto-format all code
2. `pnpm check` — format, lint, and type-check (Oxfmt, Oxlint, tsgo via Vite+)

## Code Patterns

- Business logic lives server-side; this package only folds events into UI state
- Use signals for reactive UI updates; register palettes and overlays before the double-Esc handler
- Session switching resets signals and lets the session `useSignalEffect` re-subscribe + refetch
- `@mention` file listing comes from `useProjectFiles` (server endpoint), keyed per session
- `entriesToUIMessages` renders persisted sessions — do not duplicate the conversion locally
- Keep chat views pure and `memo()`-wrapped; message objects keep identity across streamed deltas, which is what makes
  idle frames and deltas skip unchanged messages
- Render the transcript through `bundleTranscript()` so tool calls from consecutive turns collapse into one bundle row;
  its per-run call-array cache is what keeps memoized bundle bodies on the fast path, so preserve identity when
  touching the fold
- Diff presentation is pure and shared (`prettyDiff()` in `@vvtxn/relay/core/diff-view.ts`); render it through
  `DiffPreview`/`DiffViewer` instead of stuffing raw patches into `Markdown` (which would show every context line and
  bypass the preview cap)
- A global key handler that should win over run cancellation must be registered before the double-Esc handler; one that
  should lose to an open palette must be registered after the palette hooks
