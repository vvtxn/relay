# Relay v0.8.0

A coding agent with a terminal UI, built with Deno and TypeScript.

Relay is a monorepo (Deno workspace) containing a terminal UI framework powered by a custom JSX runtime and Yoga flexbox
layout, an OpenAI-compatible LLM API layer with streaming support, and an agentic loop with built-in tools. One agent
runtime is hosted by an HTTP + SSE server; the terminal client talks to it over the wire protocol.

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

Set your environment:

```bash
export TURSO_DB_URL="your-database-url"
export TURSO_DB_TOKEN="your-database-token"
export DEV_AUTH_SUBJECT="your-local-user"
# Optional — falls back to ~/.relay/auth.json written by the CLI:
export LLM_API_KEY="your-api-key"
```

### Run

Start the server (hosts the agent runtime):

```bash
deno task serve
```

Then use the client:

```bash
deno task agent        # terminal UI (another shell)
```

The compiled binary ships both: `relay serve` starts the server, `relay` starts the terminal UI.

## Architecture

```
├── packages/
│   ├── relay/              # Core agent library (@vvtxn/relay)
│   │   ├── api/            # LLM provider types and CompletionsProvider
│   │   └── core/           # Agent loop, runner, tools, sessions, context, display
│   ├── client/             # Wire protocol + RelayClient (@vvtxn/client)
│   ├── server/             # HTTP + SSE server hosting the runtime (@vvtxn/server)
│   └── cli/                # TUI client + serve subcommand (@vvtxn/cli)
│       ├── agent/          # App entry point, config, components, hooks
│       └── tui/            # Terminal UI framework (JSX runtime, Yoga layout)
├── scripts/                # Build and version bump scripts
├── dist/                   # Compiled binary output
└── deno.json               # Workspace configuration
```

### Package Dependency Graph

```
packages/relay  (leaf — no internal deps)
       ↑
packages/client  (protocol + transport, type-only relay imports)
       ↑
packages/server  (HTTP + SSE runtime host)
       ↑
packages/cli  (TUI client + serve subcommand)
```

The terminal client talks to the server over the shared protocol in `packages/client`. The agent loop, tools, and session
stores execute only in `packages/server`; `packages/relay` powers it and provides display utilities (message mapping,
diffs) to the terminal client.

### `packages/client/` — Wire Protocol + Client

The single source of truth for the server↔client contract, used by the CLI (Deno):

- `protocol.ts` — REST payloads + SSE `ServerEvent` union (plain JSON types)
- `sse.ts` — fetch-based SSE parser (no EventSource; works in Deno and browsers) + server-side frame encoder
- `client.ts` — `RelayClient` (typed methods for every endpoint, `subscribe()` for event streams)

### `packages/server/` — Agent Runtime Host

A dependency-free `Deno.serve` application:

- **RunManager** — one active run per session; bridges agent events onto per-session SSE streams; gates side-effecting
  tools behind approval decisions that arrive over HTTP
- **Sessions** — create/open/list against the shared Turso store; per-session workspace cwd (file tools are confined to
  it)
- **Auth** — local dev auth (`DEV_AUTH_SUBJECT`) resolved through the shared user store; GitHub OAuth slots in later
  behind the same contract
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

**Authentication** — Provider identities are resolved to internal user IDs before they reach application storage. Local
development uses `DEV_AUTH_SUBJECT`; GitHub identity mapping is ready for a future OAuth flow.

**Session persistence** — Conversations are stored in the shared Turso database and can be used by the terminal client. The server requires `TURSO_DB_URL`, `TURSO_DB_TOKEN`, and `DEV_AUTH_SUBJECT` while local auth is active:

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
- Command palette (`/`) for actions like "New Chat", "Threads", and "Quit"
- Tool approval prompts (`y`/`a`/`n`) for side-effecting tools, with per-process "always allow" memory
- Double Esc to cancel in-progress generation
- `@` file mentions backed by the server's project file listing

## Development

```bash
deno task fmt          # Format code
deno task fmt:check    # Check formatting
deno task lint         # Lint
deno task test         # Run tests
deno task serve        # Run the server (loads .env)
deno task agent        # Run the terminal client (requires a running server)
deno task build        # Build binary (dist/relay; includes TUI + serve)
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

The released binary reads `LLM_API_KEY` (or falls back to `~/.relay/auth.json`), `TURSO_DB_URL`, `TURSO_DB_TOKEN`, and
`DEV_AUTH_SUBJECT` from its runtime environment. Local `deno task build` builds may load `.env` automatically, but
release builds should not include secrets in the executable.

## License

MIT
