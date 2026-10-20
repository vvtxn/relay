# Relay v0.8.0

A coding agent with a terminal UI, built with Node.js and TypeScript.

Relay is a monorepo (pnpm workspace) containing a terminal UI framework powered by a custom JSX runtime and Yoga flexbox
layout, a browser client built with SolidJS, an OpenAI-compatible LLM API layer with streaming support, and an agentic
loop with built-in tools. One agent runtime is hosted by an HTTP + SSE server; the terminal and web clients talk to it
over the same wire protocol. Tooling (format, lint, type-check, builds) runs through [Vite+](https://viteplus.dev/).

> **Note — Project Transition**
>
> Relay is evolving from a local, terminal-only coding agent into a more advanced agent designed to run on both the
> terminal and the web, sharing the same sessions between clients. Conversations persist in a local SQLite database by
> default, keyed by a stable owner ID and workspace, so a session started in one client can be continued in the other.
> A shared Turso database can be configured for multi-user deployments.
>
> **No new release will be published for this work yet.** The latest GitHub Release (`v0.8.0`) predates all web
> extension related changes and still reflects the old local-only agent with filesystem session storage. Run the current
> version from source as described below.

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
- **Local-first session storage** — Conversations persist in SQLite by default; Turso is available for shared history
- **Tool approval** — Side-effecting tools wait for an allow/deny decision
- **Inline diffs** — File write and edit operations display colored unified diffs with line numbers
- **Markdown rendering** — Inline markdown display in the terminal
- **Command palette** — Fuzzy-searchable command menu in the terminal

## Install

### Single executable (Linux x64)

The local build packages the server, TUI, web app, fonts, and libSQL runtime into one executable:

```bash
pnpm install
pnpm build:sea
./dist/relay
```

The executable needs no Node.js installation. It extracts its web/font/libSQL assets to `~/.relay/runtime/<version>` on
first launch. Tagged releases attach `relay` and `relay.sha256`; `pnpm smoke:sea` verifies a local build.

### From source

Clone the repository, install dependencies, and run it with Node.js (see [Development](#development) for the full task
list):

```bash
git clone https://github.com/vvtxn/relay.git
cd relay
pnpm install
pnpm relay
```

Local mode needs no GitHub App or database setup. The server creates `~/.relay/relay.db`, uses a local identity, and
stores each user's LLM API key encrypted at rest in local files; users paste theirs in the web app's Settings page.
Set `TURSO_DB_URL`/`TURSO_DB_TOKEN` and GitHub credentials when you want a shared, multi-user deployment.

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

Environment is layered and mode-based (`RELAY_ENV=development|production`). Committed non-secret defaults live in
`.env.development` / `.env.production`; put secrets in the gitignored `.env.development.local` / `.env.production.local`
(see `.env.example`). Precedence: process env > `.env.<mode>.local` > `.env.<mode>` > `.env.local` > `.env`. Files
resolve from the working directory, falling back to the current and then the main git worktree root, so linked worktrees
load the main checkout's gitignored files.

A local run needs no `.env` at all. To use a shared Turso database and GitHub auth instead, copy the template and fill in
the cloud credentials:

```bash
cp .env.example .env.development.local
# fill in TURSO_DB_URL / TURSO_DB_TOKEN / GITHUB_APP_* for shared mode
```

### Run

The CLI is the entry point: it starts (or reuses) a background server, then runs the TUI. The server keeps running after
the CLI exits, so you can hop into the browser anytime.

```bash
pnpm relay          # start/reuse the server + terminal UI
pnpm relay web      # open the web client in the browser
pnpm relay status   # show the background server
pnpm relay stop     # stop the background server
```

The server listens on `RELAY_PORT` (default `7433`). In development, if that port is taken by something that is not a
healthy Relay server, the CLI starts one on a free port and records the actual URL in `~/.relay/server.json` (the Vite
dev proxy follows it). In production — or whenever `RELAY_PORT` is set explicitly — a taken port is a startup error.

The terminal and the browser use the same font. The browser loads it automatically; for the terminal run
`pnpm relay fonts install` and select the printed family in your terminal settings. `pnpm relay fonts status` reports
whether it is installed.

In development `relay web` opens Vite (`http://localhost:5173`) when it is running, otherwise the web app served by the
server. In production (`RELAY_ENV=production`, e.g. `pnpm relay:prod web`) the server serves the built SPA
(`packages/web/dist`) itself.

With GitHub auth, the first `pnpm relay` opens the browser to sign in; the server hands the session to the CLI (loopback
only), so the terminal and the browser act as the same user. Sign out only affects the current client.

Lower-level tasks remain for running a server in the foreground:

```bash
pnpm serve:dev           # foreground server, development env
pnpm serve:prod          # foreground server, production env
pnpm web:dev             # Vite dev server with HMR
```

`pnpm relay` builds the CLI bundle (`packages/cli/dist`) automatically and then runs the same commands as before:
`relay`, `relay web`, `relay serve`, `relay stop`, `relay status`, `relay fonts`, `relay workspace`.

## Authentication

Relay supports two auth modes:

- **Local (default)** — the server is bound to loopback and every request is the local user. No login is required.
  The API is protected from DNS rebinding by accepting only loopback `Host` headers.
- **GitHub** — callers complete a GitHub App user-authorization flow and receive an opaque session cookie (browser) or,
  for the CLI, a bearer session token handed over locally. Each GitHub account gets its own user, sessions, and
  workspaces. Enable this explicitly with `RELAY_AUTH=github` or by configuring GitHub credentials; non-loopback binds
  require it.

The rest of this section describes the shared/GitHub deployment.

### GitHub App setup

1. Create a **GitHub App** (Settings → Developer settings → GitHub Apps → New GitHub App).
   - **Callback URLs** (up to 10 — add both):
     - `http://localhost:5173/api/auth/callback` (development, via the Vite proxy)
     - `http://127.0.0.1:7433/api/auth/callback` (production)
   - Under **Permissions → Account permissions**, set **Email addresses** to _Read-only_ (used to resolve a verified
     email; the profile itself needs no permission).
   - Optionally enable **Request user authorization (OAuth) during installation**.
   - GitHub Apps use fine-grained permissions, so no OAuth `scope` is requested.
2. Put the App's **client ID** and **client secret** (not the App ID or private key) in the gitignored secrets file for
   each environment:

   ```dotenv
   # .env.development.local  (dev GitHub App)
   GITHUB_APP_CLIENT_ID="..."
   GITHUB_APP_CLIENT_SECRET="..."

   # .env.production.local   (prod GitHub App)
   GITHUB_APP_CLIENT_ID="..."
   GITHUB_APP_CLIENT_SECRET="..."
   ```

   `RELAY_PUBLIC_URL` already comes from `.env.development` / `.env.production`; `AUTH_SESSION_TTL_DAYS` defaults to 30
   and can be overridden in a `.local` file.

3. Start the matching mode (`pnpm serve:dev` + `pnpm web:dev`, or `pnpm serve:prod` after `pnpm web:build`) and sign in
   with two accounts to verify isolation.

The CLI authenticates with the bearer session token a loopback browser login hands over in `~/.relay/session.json`, so
the terminal and the browser act as the same user without extra configuration.

### Hardening

These are user-specific, so put them in the gitignored `.env.<mode>.local` file. When the server binds a non-loopback
`RELAY_HOST`, **it refuses to start unless both are set**; on loopback they are optional.

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
packages/server  (HTTP + SSE runtime host)
       ↑
packages/cli  (TUI client + serve subcommand)   packages/web  (Solid SPA client)
       ↑
packages/local  (Linux x64 single executable; packages cli + server)
```

The terminal and web clients talk to the server over the shared protocol in `packages/client`. The agent loop, tools,
and session stores execute only in `packages/server`; `packages/relay` powers it and provides display utilities (message
mapping, diffs) and the shared Graphite/Silver theme tokens to both clients.

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
- **Sessions** — create/open/list against local SQLite (default) or Turso; per-session workspace cwd (file tools are
  confined to it)
- **Auth** — local loopback identity by default, or GitHub App OAuth with per-request identity resolution, opaque
  hashed sessions, and an optional allowlist
- **Static serving** — optional static file serving when `RELAY_STATIC_DIR` is set

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

**Session persistence** — Conversations are stored in local SQLite by default (`~/.relay/relay.db`) and can be shared
by the terminal and web clients. Set `TURSO_DB_URL` and `TURSO_DB_TOKEN` to use a shared Turso database instead; GitHub
credentials are only required when `RELAY_AUTH=github` (or for a non-loopback bind).

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
pnpm relay             # Build the CLI bundle, then start/reuse the server + terminal UI
pnpm relay web         # Open the web client (server starts in the background)
pnpm relay stop        # Stop the background server
pnpm relay status      # Show the background server
pnpm relay workspace list          # List registered workspaces
pnpm relay workspace add <path>    # Register a project directory (default: cwd)
pnpm relay workspace remove <path> # Hide a workspace (sessions are kept; re-add restores it)
pnpm relay fonts status  # Check whether the shared terminal font is installed
pnpm serve:dev         # Run a foreground server with the development env
pnpm serve:prod        # Run a foreground server with the production env
pnpm web:dev           # Run the web client with Vite (proxies /api to the server)
pnpm web:build         # Build the web app to packages/web/dist
pnpm build             # Build the web app and the CLI bundle
pnpm build:sea         # Build the Linux x64 single executable (dist/relay)
pnpm smoke:sea         # Smoke-test dist/relay with a temporary HOME
pnpm run version         # Show current version
pnpm run version:bump <patch|minor|major>  # Bump version
```

The toolchain is pinned in `.node-version` and `package.json` (`engines`, `packageManager`). `vp` comes from the
project-local `vite-plus` dev dependency; run it directly as `pnpm exec vp …` or through the scripts above.

## Releasing

> **Current status:** no new release is planned while the web extension work is in progress. `v0.8.0` remains the latest
> published release and predates the shared database session changes. The steps below apply once releases resume.

Tag-based releases via GitHub Actions (`.github/workflows/release.yml`):

1. `pnpm run version:bump <patch|minor|major>`
2. Commit and push to `main`
3. `git tag v<version> && git push --tags`
4. CI verifies checks and creates the GitHub Release (source-only — no binary artifact is published)

Relay reads its configuration from the runtime environment (loaded from the mode-aware `.env` files). Local mode needs
no cloud variables; `TURSO_DB_URL`/`TURSO_DB_TOKEN` and `GITHUB_APP_CLIENT_ID`/`GITHUB_APP_CLIENT_SECRET` enable the
shared Turso/GitHub deployment. The LLM API key is per user, encrypted at rest, and kept in local files by default (set
via the web Settings page); `RELAY_SETTINGS_STORE=database` keeps it in the database instead.

## License

MIT
