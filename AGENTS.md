# AGENTS.md - Root (Monorepo)

Terminal-based coding agent with custom TUI framework.

## Repository Structure (Deno Workspace)

```
├── packages/
│   ├── relay/              # Core agent library (@vvtxn/relay)
│   │   ├── api/            # LLM provider types and CompletionsProvider
│   │   └── core/           # Agent loop, runner, tools, sessions, context, display
│   ├── client/             # Wire protocol + RelayClient (@vvtxn/client)
│   ├── server/             # HTTP + SSE server hosting the runtime (@vvtxn/server)
│   ├── web/                # Preact + Vite web client (@vvtxn/web)
│   └── cli/                # TUI client + serve subcommand (@vvtxn/cli)
│       ├── agent/          # App entry point, config, components, hooks
│       └── tui/            # Terminal UI framework (JSX runtime, Yoga layout)
├── scripts/                # Build and version bump scripts
├── dist/                   # Compiled binary output
└── deno.json               # Workspace configuration
```

## Package Dependencies

```
packages/relay  (leaf — no internal deps)
       ↑
packages/client  (protocol + transport, type-only relay imports)
       ↑                    ↑
packages/server        packages/web
       ↑
packages/cli  (TUI client + serve subcommand)
```

All clients (CLI, web) talk to the server over the shared protocol in `packages/client`; the agent runtime executes only
in the server. `packages/relay` powers the server and provides display utilities to clients.

## Build/Run Commands

- **Format code**: `deno task fmt`
- **Check formatting**: `deno task fmt:check`
- **Lint**: `deno task lint`
- **Run tests**: `deno task test` (requires `--allow-read --allow-write --allow-env --allow-run`)
- **Run agent**: `deno task agent` (requires a running server: `deno task serve`)
- **Run server**: `deno task serve` (loads `.env`; requires Turso + auth env)
- **Web dev**: `deno task web:dev` (Vite dev server, proxies /api to the local server)
- **Web build**: `deno task web:build` (outputs `packages/web/dist`)
- **Build binary**: `deno task build` (compiles to `dist/relay`, includes TUI + serve)

## Task Completion Checklist

After concluding that a task is complete, always run these commands in order:

1. `deno task fmt` — auto-format all code
2. `deno task lint` — check for lint errors
3. `deno task test` — run the test suite

If any command fails, fix the issues and re-run until all pass cleanly. Do not report the task as done until all three
pass.

### Build & Version

- **Build binary**: `deno task build` (compiles to `dist/relay`)
- **Show version**: `deno task version`
- **Bump version**: `deno task version:bump <patch|minor|major>`

### Releasing

Tag-based releases via GitHub Actions (`.github/workflows/release.yml`):

1. `deno task version:bump <patch|minor|major>`
2. Commit and push to `main`
3. `git tag v<version> && git push --tags`
4. CI builds Linux binary and creates GitHub Release

### Development (Playgrounds)

- `deno task playground:approval` - Tool approval prompt demo
- `deno task playground:command-palette` - Command palette demo
- `deno task playground:layout` - Box layout and borders demo
- `deno task playground:markdown` - Markdown rendering demo
- `deno task playground:scroll-area` - Scroll area demo
- `deno task playground:spinner` - Spinner animations demo
- `deno task playground:text-input` - Text input with vim mode demo
- `deno task playground:text-styling` - Text styling demo
- `deno task playground:welcome` - Welcome screen demo

## Import Aliases

Within each package, use `@/` for intra-package imports:

```typescript
// Inside packages/relay/core/agent.ts
import type { Message } from "@/api/types.ts";

// Inside packages/cli/agent/app.tsx
import { Box, Text } from "@/tui/render/components.tsx";
```

Cross-package imports use the `@vvtxn/` prefix with subpaths:

```typescript
// Server runtime (executes the agent)
import { startServer } from "@vvtxn/server/main.ts";

// Protocol + transport (shared by CLI and web)
import { RelayClient } from "@vvtxn/client/client.ts";

// Display utilities (browser-pure)
import { entriesToUIMessages } from "@vvtxn/relay/core/display.ts";
```

## Code Style Guidelines

- **Language**: TypeScript with strict mode
- **Runtime**: Deno
- **Formatting**: deno fmt (tabs, 120 line width, double quotes)
- **Imports**: ES modules with `.ts` extensions and `@/` path alias
- **Naming**: camelCase for variables/functions, PascalCase for types/classes, UPPER_CASE for constants

## Sub-package Guidelines

Each sub-package has its own AGENTS.md with package-specific details:

- `packages/relay/api/AGENTS.md` - LLM providers and API types
- `packages/relay/core/AGENTS.md` - Agent loop, runner, tools, sessions
- `packages/client/AGENTS.md` - Wire protocol and HTTP/SSE client
- `packages/server/AGENTS.md` - HTTP + SSE server hosting the agent runtime
- `packages/web/AGENTS.md` - Preact web client
- `packages/cli/agent/AGENTS.md` - CLI application and TUI components
- `packages/cli/tui/AGENTS.md` - Terminal UI framework

## Git Conventions

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/) with these types:

- `feat` - New feature or behavior
- `fix` - Bug fix
- `refactor` - Code restructuring without behavior change
- `style` - Formatting only (e.g., `style: run deno fmt`)
- `style(lint)` - Lint fixes
- `docs` - Documentation or README updates
- `chore` - Maintenance tasks (e.g., `chore: version bump`)
- `test` - Adding or updating tests

Use scopes when relevant: `feat(agent):`, `fix(tui):`, `refactor(core):`, `feat(diffs):`, `fix(command-palette):`, etc.

Keep the subject line concise. Use the body for additional context when needed.

### Branch Naming

Use descriptive, kebab-case branch names with a category prefix:

- `feat/description` — New features (e.g., `feat/agent-changes`, `feat/new-diffs`)
- `fix/description` — Bug fixes (e.g., `fix/md-import-crash`, `fix/stream-abort-naming`)
- `refactor/description` — Code restructuring (e.g., `refactor/signals-store`)
- `docs/description` — Documentation updates (e.g., `docs/readme-update`)
- `chore/description` — Maintenance tasks (e.g., `chore/version-bump`)

Avoid vague names like `dev`, `temp`, or `wip-description` — use the category prefix instead.

### Workflow

1. Create a branch from `main` for your changes
2. Make focused commits with clear messages
3. Push the branch to the remote

**Never push directly to `main`.** Always create a branch, even for small fixes.

### Versioning & Releases

- Use [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`
- Tag releases with a `v` prefix: `git tag v0.5.0`
- Version bumps are separate commits: `chore: version bump`
- After bumping, commit to `main`, then tag and push tags to trigger the release CI
