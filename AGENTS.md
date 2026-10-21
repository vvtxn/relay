# AGENTS.md - Root (Monorepo)

Terminal-based coding agent with custom TUI framework.

## Repository Structure (pnpm Workspace)

```
├── packages/
│   ├── relay/              # Core agent library (@vvtxn/relay)
│   │   ├── api/            # LLM provider types and CompletionsProvider
│   │   └── core/           # Agent loop, runner, tools, sessions, context, display
│   ├── client/             # Wire protocol + RelayClient + Effect service layer (@vvtxn/client)
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

## Package Dependencies

```
packages/relay  (leaf — no internal deps)
       ↑
packages/client  (protocol + transport + shared session-state reducer)
       ↑                    ↑
       ↑                    ↑
packages/server       packages/cli / packages/web
(HTTP + SSE runtime)  (clients — TUI and browser)
       ↑
packages/local        (Linux x64 single executable; packages cli + server)
```

All clients (CLI, web) talk to the server over the shared protocol in `packages/client`; the agent runtime executes only
in the server. `packages/relay` powers the server and provides display + theme utilities to clients. Both clients fold
`ServerEvent`s with the same reducer (`packages/client/session-state.ts`).

## Effect Runtime Boundaries

Effect (v4) is the runtime for asynchronous, concurrent, and resourceful code. The wire protocol and browser-pure
modules stay Effect-free on purpose.

- **One runtime per long-lived process**: the web app owns a `ManagedRuntime`
  (`packages/web/src/api/runtime.ts`); the server composes its Layers in `main.ts` (`HttpRouter.serve` +
  `Layer.launch`). Libraries (`@vvtxn/relay`, `@vvtxn/client`) expose Effects, Layers, and Streams — they never run
  them.
- **Where Effect lives**: `packages/server` (routing, handlers, RunManager, stores), node-side `packages/relay` (agent
  loop, tools, store contracts), `packages/web`, and `packages/client/services.ts` (the Effect layer over the promise
  transport).
- **Where it must not**: `@vvtxn/client/protocol.ts`, the `RelayClient`/SSE transport, the `session-state.ts` reducer,
  and the browser-pure relay modules (`core/display.ts`, `core/theme.ts`, `core/fonts.ts`). The web bundle imports
  those directly, so they must never gain an `effect` or `node:` dependency.
- The CLI's async layer is still being designed; its TUI signal store is independent of Effect.
- Prefer `Effect.gen`, `Ref`, `Deferred`, `Queue`, `Stream`, and `Schedule` over hand-rolled promise/callback
  bookkeeping in server-side code.

## Build/Run Commands

- **Format code**: `pnpm fmt`
- **Check formatting**: `pnpm fmt:check`
- **Lint**: `pnpm lint`
- **Type-check**: `pnpm check` (strict; checks every entrypoint)
- **Run CLI (local default)**: `pnpm relay` (starts/reuses the local background server, then the TUI; non-TUI
  subcommands run from source without a bundle build — see `scripts/relay.ts`)
- **Run CLI (cloud mode)**: `pnpm relay:cloud` (Turso + GitHub; same subcommands as `pnpm relay`)
- **Open web client**: `pnpm relay web` / `pnpm relay:cloud web`
- **Stop/status the background server**: `pnpm relay stop|status` / `pnpm relay:cloud stop|status` (mode-specific
  state files)
- **Manage workspaces**: `pnpm relay workspace add|list|remove [path]` or `pnpm relay:cloud workspace …`
- **Install the shared terminal font**: `pnpm relay fonts install|status` or `pnpm relay:cloud fonts …`
- **Run local server (foreground)**: `pnpm relay serve`
- **Run cloud server (foreground)**: `pnpm relay:cloud serve`
- **Run web dev server**: `pnpm web:dev` (Vite; proxies `/api` to the local server; cloud mode serves its own SPA)
- **Build web app**: `pnpm web:build` (Vite → `packages/web/dist`; serve with `RELAY_STATIC_DIR`)
- **Build web app + CLI bundle**: `pnpm build`
- **Build Linux x64 single executable**: `pnpm build:sea` (outputs `dist/relay`)

## Task Completion Checklist

After concluding that a task is complete, always run these commands in order:

1. `pnpm exec vp fmt` — auto-format all code
2. `pnpm check` — format, lint, and type-check (Oxfmt, Oxlint, tsgo via Vite+)
3. `pnpm exec vp test` — run the test suites (`packages/*/test`)

If any command fails, fix the issues and re-run until they pass cleanly. Do not report the task as done until they pass
cleanly.

### Type Checking

The root `tsconfig.base.json` `compilerOptions` apply to every workspace package and enable strict settings beyond
TypeScript's defaults: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
`noFallthroughCasesInSwitch`, `allowUnreachableCode: false`, and `allowUnusedLabels: false`. Type-checking runs through
`vp check` (tsgo), and Oxlint is the linter (configured in the root `vite.config.ts`); linting does not type-check.
Prefer real guards over `!`; use `!` only where an invariant is already guaranteed.

Code must also run under Node's native TypeScript type stripping: no enums, namespaces, parameter properties, or other
syntax that requires transformation. Only `packages/cli` is bundled (for JSX).

### Environment & Modes

`RELAY_ENV` selects `development` (default) or `production`. Tasks run through `scripts/run-env.ts`, which merges env
files with explicit precedence — **process env > `.env.<mode>.local` > `.env.<mode>` > `.env.local` > `.env`** (Node has
no multi-file "if exists" env loading, so the merge is explicit). Files resolve relative to the working directory,
falling back to the current worktree root and then the main worktree root, so gitignored secrets also load in linked
worktrees.

- `.env.development` / `.env.production` — committed non-secret mode defaults.
- `.env.local`, `.env.<mode>.local` — gitignored secrets (`TURSO_*`, `GITHUB_APP_*`).
- `.env.example` — template for every key.

### Build & Version

- **Build web app + CLI bundle**: `pnpm build`
- **Build Linux x64 single executable**: `pnpm build:sea` (outputs `dist/relay`)
- **Show version**: `pnpm run version`
- **Bump version**: `pnpm run version:bump <patch|minor|major>`

### Releasing

Tag-based releases via GitHub Actions (`.github/workflows/release.yml`):

1. `pnpm run version:bump <patch|minor|major>`
2. Commit and push to `main`
3. `git tag v<version> && git push --tags`
4. CI verifies checks and creates the GitHub Release (source-only — no binary is published)

## Import Aliases

Within each package, use `#/` for intra-package imports (Node package imports, declared in each package's `package.json`):

```typescript
// Inside packages/relay/core/agent.ts
import type { Message } from "#/api/types.ts";

// Inside packages/cli/agent/app.tsx
import { Box, Text } from "#/tui/render/components.tsx";
```

> **Native-Node caveat**: `#/` specifiers are only resolved by bundlers (Vite / `vp pack`). Node's native ESM
> loader rejects `#/` (`ERR_INVALID_MODULE_SPECIFIER`), and the server runs unbundled (`node packages/server/entry.ts`).
> Files reachable at runtime by the server (or any `node` entry) must use **relative** imports for runtime bindings;
> `import type` is fine either way since it is erased. The bundled CLI and web clients can keep using `#/`.

Cross-package imports use the `@vvtxn/` prefix with subpaths:

```typescript
// Server runtime (executes the agent)
import { startServer } from "@vvtxn/server/main.ts";

// Protocol + transport (shared by CLI and web)
import { RelayClient } from "@vvtxn/client/client.ts";

// Display utilities (browser-pure)
import { entriesToUIMessages } from "@vvtxn/relay/core/display.ts";

// Shared session event reducer (browser-pure)
import { applyServerEvent } from "@vvtxn/client/session-state.ts";

// Shared Graphite/Silver design tokens (browser-pure)
import { themeToCssVariables } from "@vvtxn/relay/core/theme.ts";
```

## Code Style Guidelines

- **Language**: TypeScript with strict mode
- **Runtime**: Node.js 26+ (native TypeScript; only the CLI is bundled)
- **Formatting**: Oxfmt via Vite+ (tabs, 120 line width, double quotes)
- **Imports**: ES modules with `.ts` extensions and the `#/` package-import alias
- **Naming**: camelCase for variables/functions, PascalCase for types/classes, UPPER_CASE for constants

## Sub-package Guidelines

Each sub-package has its own AGENTS.md with package-specific details:

- `packages/relay/api/AGENTS.md` - LLM providers and API types
- `packages/relay/core/AGENTS.md` - Agent loop, runner, tools, sessions
- `packages/client/AGENTS.md` - Wire protocol and HTTP/SSE client
- `packages/server/AGENTS.md` - HTTP + SSE server hosting the agent runtime
- `packages/cli/agent/AGENTS.md` - CLI application and TUI components
- `packages/cli/tui/AGENTS.md` - Terminal UI framework
- `packages/local/AGENTS.md` - Linux x64 single-executable packaging
- `packages/web/AGENTS.md` - Solid + Vite web client (TanStack Query/Router + Effect)

## Git Conventions

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/) with these types:

- `feat` - New feature or behavior
- `fix` - Bug fix
- `refactor` - Code restructuring without behavior change
- `style` - Formatting only (e.g., `style: run vp fmt`)
- `style(lint)` - Lint fixes
- `docs` - Documentation or README updates
- `chore` - Maintenance tasks (e.g., `chore: version bump`)

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
- `packages/relay/version.ts` is the single source; `packages/cli/version.ts` and `packages/web/src/version.ts`
  re-export it, and `scripts/bump.ts` updates it
- After bumping, commit to `main`, then tag and push tags to trigger the release CI
