# Relay v0.8.0

A coding agent with a terminal UI, built with Deno and TypeScript.

Relay is a monorepo (Deno workspace) containing a terminal UI framework powered by a custom JSX runtime and Yoga flexbox
layout, a browser client built with SolidJS, an OpenAI-compatible LLM API layer with streaming support, and an agentic
loop with built-in tools. One agent runtime is hosted by an HTTP + SSE server; the terminal and web clients talk to it
over the same wire protocol.

> **Note — Project Transition**
>
> Relay is evolving from a local, terminal-only coding agent into a more advanced agent designed to run on both the
> terminal and the web, sharing the same sessions between clients. Conversations are now persisted in a shared Turso
> database instead of local JSONL files, keyed by a stable owner ID and workspace, so a session started in one client
> can be continued in the other.
>
> **No new release will be published for this work yet.** The latest GitHub Release (`v0.8.0`) predates all web
> extension related changes and still reflects the old local-only agent with filesystem session storage. To use the new
> shared-session behavior, build from source as described below.

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
- **Shared session storage** — Conversations persist in a Turso database for shared session history
- **Tool approval** — Side-effecting tools wait for an allow/deny decision
- **Inline diffs** — File write and edit operations display colored unified diffs with line numbers
- **Markdown rendering** — Inline markdown display in the terminal
- **Command palette** — Fuzzy-searchable command menu in the terminal

## Install

> The published binary (`v0.8.0`) is the local-only agent from before the web extension changes. Session persistence in
> that binary uses local JSONL files, not the shared database. Until a new release is published, build from source to
> get the current behavior.

Download the latest Linux binary from [GitHub Releases](https://github.com/vvtxn/relay/releases/latest):

```bash
curl -L https://github.com/vvtxn/relay/releases/latest/download/relay -o relay
chmod +x relay
sudo mv relay /usr/local/bin/
```

Or build the current version from source (see [Development](#development)):

```bash
git clone https://github.com/vvtxn/relay.git
cd relay
deno task build        # outputs dist/relay
```

The server reads its LLM API key from `LLM_API_KEY`, falling back to `~/.relay/auth.json`.

Server settings (`serverUrl` for the terminal client) are configured in `~/.relay/config.json`.

## Quick Start

### Prerequisites

- [Deno](https://deno.com/) v2+

### Setup

```bash
git clone https://github.com/vvtxn/relay.git
cd relay
```

Environment is layered and mode-based (`RELAY_ENV=development|production`). Committed non-secret defaults live in
`.env.development` / `.env.production`; put secrets in the gitignored `.env.development.local` / `.env.production.local`
(see `.env.example`). Precedence: process env > `.env.<mode>.local` > `.env.<mode>` > `.env.local` > `.env`.

```bash
cp .env.example .env.development.local
# fill in TURSO_DB_URL / TURSO_DB_TOKEN (and GITHUB_APP_* when using GitHub auth)
```

### Run

The CLI is the entry point: it starts (or reuses) a background server, then runs the TUI. The server keeps running after
the CLI exits, so you can hop into the browser anytime.

```bash
deno task relay          # start/reuse the server + terminal UI
deno task relay web      # open the web client in the browser
deno task relay status   # show the background server
deno task relay stop     # stop the background server
```

In development `relay web` opens Vite (`http://localhost:5173`) when it is running, otherwise the web app bundled by the
server. In production (`RELAY_ENV=production`, e.g. `deno task relay:prod web`) the server serves the built SPA
(`packages/web/dist`) itself.

With GitHub auth, the first `deno task relay` opens the browser to sign in; the server hands the session to the CLI
(loopback only), so the terminal and the browser act as the same user. Sign out only affects the current client.

Lower-level tasks remain for running a server in the foreground:

```bash
deno task serve:dev      # foreground server, development env
deno task serve:prod     # foreground server, production env
deno task web:dev        # Vite dev server with HMR
```

The compiled binary ships the same commands: `relay`, `relay web`, `relay serve`, `relay stop`, `relay status`.
`deno task build` builds and embeds the web app (release-safe, no env); `deno task build:local` also embeds the dev env.

## Authentication

Relay is GitHub-OAuth-only. Callers authenticate by completing a GitHub App user-authorization flow and receiving an
opaque session cookie (browser) or, for the CLI, a bearer session token handed over locally. Each GitHub account gets
its own user, sessions, and workspaces. GitHub App credentials are **required** — the server refuses to start without
them.

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

3. Start the matching mode (`deno task serve:dev` + `deno task web:dev`, or `deno task serve:prod` after
   `deno task web:build`) and sign in with two accounts to verify isolation.

The CLI authenticates with the bearer session token a loopback browser login hands over in `~/.relay/session.json`, so
the terminal and the browser act as the same user without extra configuration.

### Hardening

These are user-specific, so put them in the gitignored `.env.<mode>.local` file. When the server binds a non-loopback
`RELAY_HOST`, **it refuses to start unless both are set**; on loopback they are optional.

- `AUTH_ALLOWED_GITHUB` — comma-separated GitHub logins or numeric ids allowed to sign in (empty = any GitHub account).
- `RELAY_WORKSPACE_ROOTS` — comma-separated absolute directories a session workspace may use (empty = any directory).

See [SECURITY.md](SECURITY.md) for the full threat model and checklist.

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
│   └── web/                # Solid + Vite SPA client (@vvtxn/web)
│       └── src/            # Effect API layer, TanStack Query/Router, components
├── scripts/                # Build and version bump scripts
├── dist/                   # Compiled binary output
└── deno.json               # Workspace configuration
```

### Package Dependency Graph

```
packages/relay  (leaf — no internal deps)
       ↑
packages/client  (protocol + transport + shared session-state reducer)
       ↑
packages/server  (HTTP + SSE runtime host)
       ↑
packages/cli  (TUI client + serve subcommand)   packages/web  (Solid SPA client)
```

The terminal and web clients talk to the server over the shared protocol in `packages/client`. The agent loop, tools,
and session stores execute only in `packages/server`; `packages/relay` powers it and provides display utilities (message
mapping, diffs) and the shared Graphite/Silver theme tokens to both clients.

### `packages/client/` — Wire Protocol + Client

The single source of truth for the server↔client contract, used by the CLI (Deno) and web (browser):

- `protocol.ts` — REST payloads + SSE `ServerEvent` union (plain JSON types)
- `sse.ts` — fetch-based SSE parser (no EventSource; works in Deno and browsers) + server-side frame encoder
- `client.ts` — `RelayClient` (typed methods for every endpoint, `subscribe()` for event streams)
- `session-state.ts` — pure `applyServerEvent` reducer shared by both clients so run rendering cannot drift

### `packages/server/` — Agent Runtime Host

A dependency-free `Deno.serve` application:

- **RunManager** — one active run per session; bridges agent events onto per-session SSE streams; gates side-effecting
  tools behind approval decisions that arrive over HTTP
- **Sessions** — create/open/list against the shared Turso store; per-session workspace cwd (file tools are confined to
  it)
- **Auth** — GitHub App OAuth with per-request identity resolution, opaque hashed sessions, and an optional allowlist
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

**Session persistence** — Conversations are stored in the shared Turso database and can be used by the terminal client.
The server requires `TURSO_DB_URL`, `TURSO_DB_TOKEN`, `GITHUB_APP_CLIENT_ID`, and `GITHUB_APP_CLIENT_SECRET`:

- **Create** — New sessions with unique IDs and timestamps
- **Continue** — Resume the most recent session for a workspace
- **Open** — Load a specific session by opaque session ID
- **List** — Browse all sessions with summaries (first user message preview)
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
- **TanStack Router** puts the active session in the URL (`/s/:sessionId`) for deep links and history
- **Effect** owns the live run: `Api` + `SessionStream` services, a reconnect loop with exponential backoff, and typed
  errors; events fold into Solid state via the shared `session-state.ts` reducer
- Chat with live drafts and tool cards (rendered diffs), `@`-mention picker, approval dialog, token/cost status bar, and
  cancel
- **Workspaces** — the sidebar lists the project directories the server knows about (the ones you launched `relay` in);
  selecting one filters its sessions and targets new chats. New projects are added from the CLI or via "Add workspace".
- Shares the Graphite/Silver theme tokens with the terminal client (applied as CSS variables)
- Auth uses GitHub App OAuth: credentialed fetches, 401 handling, and a login redirect

## Development

```bash
deno task fmt          # Format code
deno task fmt:check    # Check formatting
deno task lint         # Lint
deno task check        # Strict type-check every entrypoint
deno task test         # Run tests
deno task relay        # Start/reuse the server + terminal UI
deno task relay web    # Open the web client (server starts in the background)
deno task relay stop   # Stop the background server
deno task relay status # Show the background server
deno task serve:dev    # Run a foreground server with the development env
deno task serve:prod   # Run a foreground server with the production env
deno task web:dev      # Run the web client with Vite (proxies /api to the server)
deno task web:build    # Build the web app to packages/web/dist
deno task build        # Build binary (dist/relay; embeds web, release-safe, no env)
deno task build:local  # Build binary embedding the dev env (may include secrets)
deno task version      # Show current version
deno task version:bump <patch|minor|major>  # Bump version
```

### Playgrounds

Interactive demos for individual TUI components:

```bash
deno task playground:command-palette  # Command palette
deno task playground:layout           # Flexbox layout and borders
deno task playground:markdown         # Markdown rendering
deno task playground:scroll-area      # Scroll area
deno task playground:spinner          # Spinner animations
deno task playground:text-input       # Text input with vim mode
deno task playground:text-styling     # Text styling
deno task playground:welcome          # Welcome screen
```

## Releasing

> **Current status:** no new release is planned while the web extension work is in progress. `v0.8.0` remains the latest
> published release and predates the shared database session changes. The steps below apply once releases resume.

Tag-based releases via GitHub Actions (`.github/workflows/release.yml`):

1. `deno task version:bump <patch|minor|major>`
2. Commit and push to `main`
3. `git tag v<version> && git push --tags`
4. CI builds the Linux binary without embedding environment files and creates the GitHub Release

The released binary reads `LLM_API_KEY` (or falls back to `~/.relay/auth.json`), `TURSO_DB_URL`, `TURSO_DB_TOKEN`,
`GITHUB_APP_CLIENT_ID`, and `GITHUB_APP_CLIENT_SECRET` from its runtime environment. Local `deno task build` builds may
load `.env` automatically, but release builds should not include secrets in the executable.

## License

MIT
