# Relay v0.8.0

A coding agent with a terminal UI, built with Node.js and TypeScript.

Relay is a monorepo (pnpm workspace) containing a terminal UI framework powered by a custom JSX runtime and Yoga flexbox
layout, a browser client built with SolidJS, an OpenAI-compatible LLM API layer with streaming support, and an agentic
loop with built-in tools. One agent runtime is hosted by an HTTP + SSE server; the terminal and web clients talk to it
over the same wire protocol. Tooling (format, lint, type-check, builds) runs through [Vite+](https://viteplus.dev/).

> **Note — Project Transition**
>
> Relay is a cloud-first, terminal-and-web coding agent. The primary deployment uses Turso for shared sessions and
> GitHub for identity, with the bundled web app served on port 7433. A local self-hosted mode (SQLite + local auth) is
> available for running the same runtime on your own machine.
>
> **No new release will be published for this work yet.** The latest GitHub Release (`v0.8.0`) predates the shared
> database session and cloud/local split changes and still reflects the old local-only agent with filesystem session
> storage. Run the current version from source as described below.

## Features

- **Terminal client** — TUI that connects to the server for shared sessions
- **Web client** — SolidJS SPA (TanStack Query/Router + Effect) served by the same server
- **Custom JSX-based TUI framework** — Flexbox layout via Yoga, double-buffered rendering, reactive signals, vim-mode
  text input
- **Streaming chat** — Real-time message rendering with live drafts and tool call cards
- **OpenAI-compatible API layer** — Works with any provider exposing `/v1/chat/completions` (OpenRouter, OpenAI, local
  models, etc.)
- **Streaming agent loop** — Async generator that yields events for real-time UI updates as the LLM thinks and uses
  tools
- **Built-in tools** — Bash, file read/write/edit, and grep for filesystem interaction
- **Managed boxes (experimental)** — Standalone Microsandbox microVMs with copy-on-write workspaces, live agent-driven
  resizing, pause/wake, and VM-isolated bash
- **Shared cloud sessions** — Conversations persist in Turso behind GitHub auth; local self-hosting uses SQLite
- **Tool approval** — Side-effecting tools wait for an allow/deny decision
- **Inline diffs** — File write and edit operations display colored unified diffs with line numbers
- **Markdown rendering** — Inline markdown display in the terminal
- **Command palette** — Fuzzy-searchable command menu in the terminal

## Install

### From source (cloud, primary)

Clone the repository, install dependencies, configure the single `.env`, and run the cloud build:

```bash
git clone https://github.com/vvtxn/relay.git
cd relay
pnpm install
cp .env.example .env
# fill in TURSO_DB_URL / TURSO_DB_TOKEN / GITHUB_APP_*
pnpm relay
```

`pnpm relay` builds the bundled web app and CLI, starts the server on `127.0.0.1:7433`, and serves the SPA itself.
Cloud mode requires Turso and a GitHub App.

### Single executable (local, secondary, Linux x64)

The self-hosted build packages the server, TUI, web app, fonts, and libSQL runtime into one Linux x64 executable:

```bash
pnpm install
pnpm build:sea
./dist/relay
```

The executable needs no Node.js installation. It extracts its web/font/libSQL assets to `~/.relay/runtime/<version>` on
first launch. Tagged releases attach `relay` and `relay.sha256`. Set `RELAY_FLAVOR=cloud` in `.env` to run the same
executable against Turso and GitHub.

Server settings (`serverUrl` for the terminal client) are configured in `~/.relay/config.json`.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v26.11.1+ (see `.node-version`)
- [pnpm](https://pnpm.io/) v11+ (`corepack enable` or the standalone installer)

### Setup

```bash
git clone https://github.com/vvtxn/relay.git
cd relay
```

Relay uses one gitignored `.env`; `.env.example` documents every key. Process environment values win, and linked
worktrees fall back to the main checkout's `.env`. There are no development/production env files.

Cloud mode needs the Turso and GitHub credentials in `.env`:

```bash
cp .env.example .env
# fill in TURSO_DB_URL / TURSO_DB_TOKEN / GITHUB_APP_*
```

Local mode needs no cloud credentials.

### Run

The CLI is the entry point: it builds the bundled web app and CLI, starts (or reuses) a background server, then runs
the TUI. The server keeps running after the CLI exits, so you can hop into the browser anytime.

```bash
pnpm relay           # cloud: Turso + GitHub, bundled SPA on 127.0.0.1:7433
pnpm relay:local     # local: SQLite + local auth, same port
pnpm relay web       # open the cloud web client
pnpm relay:local web # open the local web client
pnpm relay stop      # stop the cloud background server
pnpm relay:local stop # stop the local background server
```

Local and cloud track their servers separately (`~/.relay/server-local.json` and `~/.relay/server-cloud.json`), so
`stop`, `status`, `web`, `serve`, `workspace`, and `fonts` work for both. The server listens on `RELAY_PORT` (default
`7433`); a taken port is a startup error unless you set a different `RELAY_PORT` explicitly.

The terminal and the browser use the same font. The browser loads it automatically; for the terminal run
`pnpm relay fonts install` and select the printed family in your terminal settings. `pnpm relay fonts status` reports
whether it is installed.

The GitHub login runs on the server origin (`127.0.0.1:7433`); there is no separate dev server. After the first
`pnpm relay`, the server hands the CLI session token over locally, so the terminal and browser act as the same user.
Sign out only affects the current client.

Lower-level tasks remain for running a server in the foreground:

```bash
pnpm relay serve         # foreground cloud server
pnpm relay:local serve   # foreground local server
```

Both entry points build the bundled web app + CLI for `relay`, `web`, and `serve`, then run the same subcommands.
Use `pnpm relay <command>` for cloud mode and `pnpm relay:local <command>` for local mode:
`web`, `serve`, `stop`, `status`, `fonts`, `workspace`, and `version`.

## Authentication

Relay has two flavors:

- **Cloud (primary)** — GitHub App OAuth. Callers receive an opaque `relay_cloud_session` cookie (browser) or a bearer
  session token handed over locally (CLI). Each GitHub account gets its own user, sessions, and workspaces.
- **Local (secondary)** — SQLite and a fixed loopback identity. No login, no auth cookie. The authenticated wrapper
  rejects non-loopback `Host` headers (DNS-rebinding guard) and retires the legacy pre-split cookie.

The rest of this section describes the cloud/GitHub deployment.

### GitHub App setup

1. Create a **GitHub App** (Settings → Developer settings → GitHub Apps → New GitHub App).
   - **Callback URL**:
     - `http://127.0.0.1:7433/api/auth/callback`

     Set `RELAY_PUBLIC_URL` to the same origin when deploying behind a hostname.
   - Under **Permissions → Account permissions**, set **Email addresses** to _Read-only_ (used to resolve a verified
     email; the profile itself needs no permission).
   - Optionally enable **Request user authorization (OAuth) during installation**.
   - GitHub Apps use fine-grained permissions, so no OAuth `scope` is requested.
2. Put the App's **client ID** and **client secret** (not the App ID or private key) in the single gitignored `.env`:

   ```dotenv
   GITHUB_APP_CLIENT_ID="..."
   GITHUB_APP_CLIENT_SECRET="..."
   ```

   `AUTH_SESSION_TTL_DAYS` defaults to 30.

3. Start cloud mode with `pnpm relay` (or `pnpm relay serve` for a foreground server) and sign in with two accounts to
   verify isolation.

The CLI authenticates with the bearer session token a loopback browser login hands over in `~/.relay/session.json`, so
the terminal and the browser act as the same user without extra configuration.

### Hardening

These are user-specific, so put them in the gitignored `.env` file. When the server binds a non-loopback `RELAY_HOST`,
**it refuses to start unless all three are set**; on loopback they are optional.

- `RELAY_PUBLIC_URL` — the HTTPS origin GitHub redirects back to (must match the GitHub App callback URL).
- `AUTH_ALLOWED_GITHUB` — comma-separated GitHub logins or numeric ids allowed to sign in (empty = any GitHub account).
- `RELAY_WORKSPACE_ROOTS` — comma-separated absolute directories a session workspace may use. Local auth allows any
  directory by default; GitHub/shared mode defaults to the server user's home directory. Set it to `*` to allow any
  directory (or list one or more roots). Cannot be `*` when binding a non-loopback host with GitHub auth.

A workspace path is validated when it is created or registered: it must be an absolute, existing directory, and its
canonical (symlink-resolved) path must sit within an allowed root.

## Architecture

```
├── packages/
│   ├── relay/              # Core agent library (@vvtxn/relay)
│   │   ├── api/            # LLM provider types and CompletionsProvider
│   │   └── core/           # Agent loop, runner, tools, sessions, context, display
│   ├── client/             # Wire protocol + RelayClient (@vvtxn/client)
│   ├── server/             # HTTP + SSE server hosting the runtime (@vvtxn/server)
│   ├── box/                # Per-session Microsandbox VMs (@vvtxn/box)
│   ├── cli/                # TUI client + serve subcommand (@vvtxn/cli)
│   │   ├── agent/          # App entry point, config, components, hooks
│   │   └── tui/            # Terminal UI framework (JSX runtime, Yoga layout)
│   ├── local/              # Linux x64 single-executable packaging (@vvtxn/local)
│   └── web/                # Solid + Vite SPA client (@vvtxn/web)
│       └── src/            # Effect API layer, TanStack Query/Router, components
├── scripts/                # Env loading and version bump scripts
├── pnpm-workspace.yaml     # Workspace definition
├── vite.config.ts          # Workspace-wide Vite+ tooling (fmt/lint/check)
└── tsconfig.base.json      # Shared strict TypeScript options
```

Only the CLI and the `packages/local` SEA entry need bundling (Node cannot run TSX); everything else runs as native
TypeScript under Node 26. The CLI bundle lives in `packages/cli/dist` and is produced by `pnpm relay` / `pnpm build`.
`pnpm build:sea` embeds it, the web app, fonts, and the libSQL runtime in `dist/relay`.

### Package Dependency Graph

```
packages/relay  (leaf — no internal deps)
       ↑
packages/client  (protocol + transport + shared session-state reducer)
       ↑
packages/server  (HTTP + SSE runtime host) ←── packages/box  (Microsandbox runtime, leaf)
       ↑
packages/cli  (TUI client + serve subcommand)   packages/web  (Solid SPA client)
       ↑
packages/local  (Linux x64 single executable; packages cli + server)
```

The terminal and web clients talk to the server over the shared protocol in `packages/client`. The agent loop, tools,
and session stores execute only in `packages/server`; `packages/relay` powers it and provides display utilities (message
mapping, diffs) and the shared Graphite/Silver theme tokens to both clients. The server optionally uses `packages/box`
for VM-isolated sessions.

### `packages/client/` — Wire Protocol + Client

The single source of truth for the server↔client contract, used by the CLI (Node) and web (browser):

- `protocol.ts` — REST payloads + SSE `ServerEvent` union (plain JSON types)
- `sse.ts` — fetch-based SSE parser (no EventSource; works in Node and browsers) + server-side frame encoder
- `client.ts` — `RelayClient` (typed methods for every endpoint, `subscribe()` for event streams)
- `session-state.ts` — pure `applyServerEvent` reducer shared by both clients so run rendering cannot drift

### `packages/server/` — Agent Runtime Host

An HTTP + SSE server built on `effect/http` and `@effect/platform-node`:

- **RunManager** — one active run per session; bridges agent events onto per-session SSE streams; gates side-effecting
  tools behind approval decisions that arrive over HTTP
- **Sessions** — create/open/list against Turso (cloud, primary) or local SQLite (self-hosted); per-session workspace
  cwd (file tools are confined to it)
- **Auth** — GitHub App OAuth in cloud mode, or a fixed loopback identity in local mode, with per-request identity
  resolution, opaque hashed sessions, and an optional GitHub allowlist
- **Static serving** — serves the bundled web app by default; `RELAY_STATIC_DIR` overrides its location

### `packages/box/` — Managed Microsandbox VMs

Optional isolated execution. Boxes are independent of sessions: a box owns a Microsandbox microVM and a
copy-on-write clone of a project, and sessions attach to it. The agent can resize the current box live; idle boxes
pause first (services stay warm), then stop after a longer idle window.

- `manager.ts` — box identity, attachments, leases, live resize, pause/stop, budgets, queue, reconciliation, GC
- `profiles.ts` — `tiny` (1 vCPU / 2 GB), `small` (2 / 4 GB), `medium` (4 / 8 GB) with disk bundles
- `workspace.ts` — reflink clone of the current working tree (including dirty/untracked state), linked-worktree handling
- `sanitize.ts` — removes `.env*`, `.npmrc`, SSH/cloud credentials, and git URL credentials before the box starts
- `manifest.ts` — versioned `box.json` per box under `RELAY_BOX_DATA_DIR`; sessions are attachments, not identity
- `microsandbox.ts` — the only module that imports the native Microsandbox SDK

Enable with `RELAY_BOX=1`; see `.env.example` for profiles, budgets, idle timers, and image settings. A project can add
`.relay/box.json` for its image, profile ceiling, and setup/resume hooks. The agent starts at `tiny` and uses the `box`
tool to resize before Playwright/browser tests, large builds, or multiple services. The default ceiling is `small`;
set `RELAY_BOX_MAX_PROFILE=medium` and raise `RELAY_BOX_MEMORY_BUDGET_MIB` above 8 GiB to enable `medium`.

Build the prepared toolchain image once (Node 26, pnpm, Playwright + Chromium, git, ripgrep, build tools, databases):

```bash
pnpm box:image
```

With the default `RELAY_BOX_IMAGE=auto`, new boxes use `relay-box:local` when it is loaded and fall back to
`node:26-bookworm` otherwise. Playwright browsers are embedded at `/opt/playwright`, so the agent can run browser tests
without downloading Chromium inside every box.

Boxes require Linux KVM, macOS Apple Silicon, or Windows WHP. The manager enforces a memory/CPU budget in addition to
the running-box count, so paused boxes and concurrent sessions cannot oversubscribe the host.

Use `relay box list|new|resize|pause|resume|stop|attach|detach|rm` to manage boxes; `relay box new [path]` creates a
standalone box without starting a thread.

Boxes are the working copy: there is no sync-back command. When `RELAY_BOX_GITHUB_TOKEN` (or `GITHUB_TOKEN`) is set,
the agent can commit and push from inside the box; the real token stays on the host and is substituted only for
`RELAY_BOX_GIT_HOST` (default `github.com`). Without a token, local commits work but pushes fail.

### `packages/relay/api/` — LLM Provider Layer

Provides an OpenAI-compatible API client with streaming SSE support. Any provider that exposes `/v1/chat/completions`
works out of the box.

- `types.ts` — Standardized types (`Message`, `CompletionRequest`, `ToolDefinition`, etc.)
- `providers/completions.ts` — Generic completions provider with streaming and cost tracking
- `streaming/stream.ts` — SSE stream parser

### `packages/relay/core/` — Agent Loop & Tools

The agent loop is an async generator (`run()`) that streams `AgentEvent`s:

1. Build context (system prompt + history + tool definitions)
2. Stream LLM response, yielding `text_delta`, `tool_call_start`, `tool_call_args_delta`, `tool_call_end` events
3. Execute tool calls, yield `tool_result` events
4. Repeat until the LLM responds without tool calls (up to configurable max rounds)

**Built-in tools:**

| Tool (internal) | Display Name | Description                      |
| --------------- | ------------ | -------------------------------- |
| `bash`          | Run          | Execute shell commands           |
| `read_file`     | Read         | Read file contents               |
| `write_file`    | Write        | Write/create files (with diff)   |
| `edit_file`     | Edit         | Edit files with diff output      |
| `grep`          | Grep         | Search files with regex patterns |

**Authentication** — Provider identities are resolved to internal user IDs before they reach application storage. GitHub
profiles are mapped through `GitHubAuthProvider` on first sign-in; every request then resolves the session token to that
user.

**Session persistence** — Cloud mode stores conversations in Turso behind GitHub auth. Local mode uses
`~/.relay/relay.db` and needs no cloud credentials. Both are shared by the terminal and web clients.

- **Create** — New sessions with unique IDs and timestamps
- **Continue** — Resume the most recent session for a workspace
- **Open** — Load a specific session by opaque session ID
- **List** — Browse all sessions with summaries (first user message preview)
- **Bounded or unlimited** — Local mode keeps every session by default; Turso defaults to the 10 most recently active
  sessions per workspace. Set `RELAY_MAX_SESSIONS_PER_WORKSPACE` to a positive number to enable pruning, or `0` to keep
  everything. Pruned sessions and their entries are removed automatically
- **Cross-client** — A session started in the terminal can be continued on another terminal, and vice versa
- **Token tracking** — Per-session token and cost counts persisted in session metadata

Sessions store metadata plus ordered entries: user/assistant messages and tool results. The workspace path is part of
the session scope, so sessions from different projects remain separate.

### `packages/cli/tui/` — Terminal UI Framework

A custom terminal UI framework with:

- `theme.ts` — Centralized color theme
- **Custom JSX runtime** — Compiles JSX to VNodes, reconciles instance trees
- **Yoga layout** — Full flexbox support (direction, justify, align, wrap, gap, padding, absolute positioning)
- **Double-buffered rendering** — Flicker-free differential updates
- **Signals reactivity** — `@preact/signals-core` for automatic re-renders

**Components:**

| Component          | Description                                                 |
| ------------------ | ----------------------------------------------------------- |
| `<Box>`            | Flexbox container with borders, padding, background color   |
| `<Text>`           | Styled text (color, bold, italic, underline, strikethrough) |
| `<TextInput>`      | Text input with cursor and vim mode support                 |
| `<Spinner>`        | Animated spinner                                            |
| `<ScrollArea>`     | Scrollable container with scrollbar and auto-scroll         |
| `<Markdown>`       | Renders markdown as styled terminal text                    |
| `<CommandPalette>` | Fuzzy-searchable command menu overlay                       |

**Hooks:**

| Hook                      | Description                         |
| ------------------------- | ----------------------------------- |
| `useSignal(value)`        | Persistent reactive signal          |
| `useSignalEffect(fn)`     | Reactive side effect with cleanup   |
| `useTextInput(opts)`      | Text input state with vim mode      |
| `useScrollArea(opts)`     | Scroll state with keyboard control  |
| `useCommandPalette(opts)` | Command palette state and filtering |

### `packages/cli/agent/` — Terminal Application

A thin TUI client of the server:

- Status bar with model, git branch, token usage progress bar, and cost tracking
- Scrollable chat history with markdown rendering
- Streaming tool call display
- Vim-mode text input
- Command palette (`/`) for actions like "New Chat", "Threads", "Open in Browser", and "Quit"
- Tool approval prompts (`y`/`a`/`n`) for side-effecting tools, with per-process "always allow" memory
- Double Esc to cancel in-progress generation
- `@` file mentions backed by the server's project file listing
- Ensures (or reuses) the background server, so `relay` works without a separate `serve`

### `packages/web/` — Browser Application

A SolidJS single-page app served by the server (bundled `packages/web/dist`, or `RELAY_STATIC_DIR`):

- **TanStack Query** owns REST server state (identity, workspaces, sessions, files) and mutations
- **TanStack Router** puts the root overview (`/`), a workspace pane (`/w/<token>`), and the active session
  (`/s/:sessionId`) in the URL for deep links and history
- **Effect** owns the live run: `Api` + `SessionStream` services, a reconnect loop with exponential backoff, and typed
  errors; events fold into Solid state via the shared `session-state.ts` reducer
- Chat with live drafts and tool cards (rendered diffs), `@`-mention picker, approval dialog, token/cost status bar, and
  cancel
- **Workspaces** — `/` is the root overview (workspace cards plus a "continue last chat" shortcut), `/w/<token>` is a
  workspace pane listing every thread for that directory with a search box, and chats stay at `/s/:id`. The sidebar
  renders workspaces as a collapsible tree showing the latest three threads each (with a `+N more…` link to the pane).
  New chats go to the active workspace, falling back to the last visited one (the server reuses an idle empty session).
  "Add workspace" accepts an absolute path, validates it against the server (with an inline error when the directory is
  missing or outside the allowed roots), and registers it immediately. "Hide" tombstones a workspace — its threads stay
  reachable and re-adding it or starting a chat there restores it. Workspaces whose directory has since been deleted
  are flagged as `missing`. Projects can also be added from the terminal with `relay workspace add [path]`, which
  attaches to the running server without opening the TUI.
- Shares the Graphite/Silver theme tokens with the terminal client (applied as CSS variables)
- Auth uses GitHub App OAuth: credentialed fetches, 401 handling, and a login redirect

## Development

```bash
pnpm fmt               # Format code (Oxfmt via Vite+)
pnpm fmt:check         # Check formatting
pnpm lint              # Lint (Oxlint via Vite+)
pnpm check             # Format, lint, and type-check (tsgo via Vite+)
pnpm relay             # Cloud: build bundles, then start/reuse the server + terminal UI
pnpm relay:local       # Local self-host: SQLite + local auth
pnpm relay web         # Open the cloud web client (server starts in the background)
pnpm relay:local web   # Open the local web client
pnpm relay stop        # Stop the cloud background server
pnpm relay:local stop  # Stop the local background server
pnpm relay status      # Show the cloud background server
pnpm relay workspace list          # List registered workspaces
pnpm relay workspace add <path>    # Register a project directory (default: cwd)
pnpm relay workspace remove <path> # Hide a workspace (sessions are kept; re-add restores it)
pnpm relay fonts status  # Check whether the shared terminal font is installed
pnpm relay serve       # Run a foreground cloud server
pnpm relay:local serve # Run a foreground local server
pnpm web:build         # Build the web app to packages/web/dist
pnpm build             # Build the web app and the CLI bundle
pnpm build:sea         # Build the Linux x64 single executable (dist/relay)
pnpm run version         # Show current version
pnpm run version:bump <patch|minor|major>  # Bump version
```

The toolchain is pinned in `.node-version` and `package.json` (`engines`, `packageManager`). `vp` comes from the
project-local `vite-plus` dev dependency; run it directly as `pnpm exec vp …` or through the scripts above.

## Releasing

> **Current status:** the cloud-first and local self-host changes are not in a tagged release yet. `v0.8.0` remains the
> latest published release and predates the shared database session changes. The steps below apply once releases resume.

Tag-based releases via GitHub Actions (`.github/workflows/release.yml`):

1. `pnpm run version:bump <patch|minor|major>`
2. Commit and push to `main`
3. `git tag v<version> && git push --tags`
4. CI verifies checks, builds `dist/relay`, and attaches the executable + checksum to the GitHub Release

Relay reads its configuration from the runtime environment (loaded from the single `.env`). Cloud mode requires
`TURSO_DB_URL`/`TURSO_DB_TOKEN` and `GITHUB_APP_CLIENT_ID`/`GITHUB_APP_CLIENT_SECRET`; local mode needs no cloud
variables. The LLM API key is per user, encrypted at rest, and kept in local files by default (set via the web Settings
page); `RELAY_SETTINGS_STORE=database` keeps it in the database instead.

## License

MIT
