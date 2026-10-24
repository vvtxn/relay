# AGENTS.md - Server

HTTP + SSE server hosting the Relay agent runtime, built on `effect/http` and
`@effect/platform-node`. Routing, handlers, streaming, and persistence all speak Effect from the edge inward.

## Architecture

```
server/
├── package.json     # @vvtxn/server; exports "./main" for the CLI serve subcommand
├── mod.ts           # Public exports (startServer, createServices, handleRequest, RunManager)
├── main.ts          # startServer(): config from env → createServices → HttpRouter.serve + Layer.launch
├── entry.ts         # Direct executable entry; imports main.ts so importing it has no side effects
├── config.ts        # serverConfigFromEnv: port, host, LLM key/model, local/Turso DB, auth, static dir
├── services.ts      # ServerServices + serverLayer — the composition seam
├── router.ts        # HttpRouter app: routes, CSRF/auth guards, error mapping, SPA fallback, handleRequest
├── identity.ts      # Per-request user resolution (cookie/bearer session)
├── auth-routes.ts   # /api/auth/login|callback|logout (GitHub OAuth)
├── github-oauth.ts  # GitHub authorize/token/profile calls + PKCE (promise-based fetch leaf)
├── cookies.ts       # Cookie serialization helpers
├── http.ts          # json()/error() helpers, requestUrl, readJsonBody, HTTP error classes
├── sessions.ts      # /api/me, /api/config, session CRUD, message submission
├── run.ts           # RunManager: one fiber per run, SSE fan-out, approvals
├── box-tools.ts     # box bash executor + model-facing box status/resize tool
├── browser-tool.ts  # one-shot Playwright check inside the current box
├── boxes.ts         # /api/boxes routes (create/list/attach/resize/pause/stop/rm)
├── box-summary.ts   # BoxStatus -> wire BoxSummary projection
├── approvals.ts     # /api/sessions/:id/approve + /cancel handlers
├── sse.ts           # GET /api/sessions/:id/events (snapshot + live stream + heartbeat)
├── files.ts         # GET /api/sessions/:id/files (project file listing for @-mentions)
├── workspace.ts     # /api/workspace(s) routes
└── settings.ts      # Per-user API key routes
```

## Key Concepts

### Composition seam (`services.ts`)

`serverLayer(config)` composes tagged services (`Config`, `Database`, the stores, `Runs`) as Effect Layers; acquisition
is sequential (config → database → stores → RunManager) and the store layer awaits each schema `ready` in order
(`users` backs the `auth_sessions` foreign key, so that schema is created first). `UserSettings` is built by
`createUserSettingsStore`: the file backend plus a one-shot migration of database keys, or the encrypted database
store. `createServices(config)` materializes the bundle once for `main.ts`. The shared `Database` client is the libSQL
driver in both modes: a `file:` URL opens embedded SQLite, a `libsql://` URL talks to Turso. `main.ts` closes it on
SIGTERM/SIGINT so SQLite checkpoints its WAL.

### HTTP (`router.ts`, `main.ts`)

`createAppLayer(services)` builds the `HttpRouter` application; `main.ts` serves it through `NodeHttpServer.layer` +
`HttpRouter.serve` + `Layer.launch`, and a `Layer.tap` writes the CLI state file **after** the listener binds.
`startServer()` keeps its signature. `handleRequest(services, request)` is an in-process `toWebHandler` adapter for
`mod.ts` consumers.

- Route handlers are Effects returning `HttpServerResponse`; `authenticated` wraps the CSRF origin check and the
  per-request identity resolution (401 when unauthenticated), `withCsrf` covers public state-changing routes.
- `respond()` maps typed errors to 400/401/403/404/413; anything else logs and returns a 500. Unknown `/api/*` paths
  return JSON 404s, and the `/api/sessions/*` pattern keeps the historical 405 for known paths with wrong methods.
- Non-API GETs fall through to `HttpStaticServer` (`spa: true`): the SPA shell is served for extension-less paths that
  accept `text/html`, everything else 404s. `RELAY_STATIC_DIR` overrides the built `packages/web/dist`.
- Request bodies go through `readJsonBody` (streamed, 1 MiB cap); cookies come from `HttpServerRequest.cookies`.

### RunManager (`run.ts`)

Owns active runs, one per session:

- `startMessage()` claims the slot synchronously (409-equivalent via `RunConflictError`) then forks the run fiber
- The fiber consumes the agent `run()` stream and mirrors events onto a run `Ref` and per-subscriber `Queue`s
  (registered synchronously, so the SSE snapshot-then-subscribe sequence cannot drop events)
- `cancel()` interrupts the fiber; a single uninterruptible finalizer aborts the provider call, denies still-pending
  approvals (their `Deferred`s resolve), flushes the session handle, publishes `run_finished`, and releases the session
  when idle and unwatched
- Approvals are `Deferred`s; `resolveApproval()` takes one out of the `Ref` atomically and resolves it. **Boxed runs
  skip the approval wrapper entirely** — the VM is the boundary. Host runs keep the layer, where only unconfined tools
  prompt (reads, confined file mutations, and `delegate` execute unattended; bash asks). Prompts are serialized per
  session (a semaphore) so custom gated tool sets may execute in parallel while the protocol surfaces one pending
  approval at a time, and queued calls re-check `alwaysApproved`/abort before prompting
- Each run registers a `delegate` subagent tool (relay core) with the read-only workspace tools, and builds its system
  prompt from the run's registry (`buildSystemPrompt`); subagent cost rides on the tool result's `meta.cost` and is
  added to the session total. When the prepared box image is active, the prompt adds a firm Browser Verification
  section: UI changes must be checked with the embedded Playwright/Chromium before completion. The `browser` tool
  runs that check through the current box lease; it must never spawn a second sandbox.
- `subscribe`/`subscribeStream` register SSE consumers; `getRunState` serves the catch-up `run_state` snapshot
- "always allow" is per session, in memory

### Sessions

Store contracts are Effect-native (`SessionHandle`/`SessionStore`, `StoreError`); synchronous in-memory reads
(`getEntries`, `getHeader`, tokens/cost) stay synchronous. Database stores insert sessions lazily (on first append), so
sessions created in-process are not yet visible to `store.open()`; all session routes go through `openSessionHandle()`
(sessions.ts), which falls back to the live RunManager handle.

The database store keeps at most `RELAY_MAX_SESSIONS_PER_WORKSPACE` sessions per owner/workspace. `0` means unlimited
(the local default); Turso deployments default to 10. When a user message is persisted with a finite limit, the
insert/update and the delete of older sessions plus their entries run in one atomic batch. `pruneAll()` trims
pre-existing overflow on startup, before any runs are active. `DatabaseSessionStore.onPruned` reports removed session
ids; `createServices` wires it to `boxes.detachSessions` so pruned threads do not keep box attachments alive.

The per-session workspace cwd comes from the client (CLI sends its terminal cwd). File tools are confined to that cwd;
bash is not (documented in relay core AGENTS.md).

Workspace creation and registration run through `validateWorkspacePath` (core): the path must be an absolute, existing
directory whose canonical (symlink-resolved) path sits within `config.workspaceRoots`. `handleCreateSession` stores the
canonical path and registers it; read paths (`?cwd=` on session lists) and unregistration canonicalize the same way, so
a symlinked path matches the stored workspace. `handleListWorkspaces` marks deleted directories with `exists: false` and
only injects the server default when nothing else is known; a removed workspace is tombstoned (`hidden_workspaces`) and
comes back when it is re-registered or a new session is created in it. Because empty sessions are not persisted until
their first message, `handleCreateSession` reuses an idle empty session from the RunManager instead of creating a new
one. `RunManager` re-validates the cwd before every run.

### Auth

Two transports:

- **Local (secondary)** — the server seeds a stable `local` identity through the user store and every loopback request
  resolves to it without a token. The authenticated wrapper rejects non-loopback `Host` headers (DNS-rebinding guard),
  clears the legacy pre-split cookie, and does not mount OAuth routes. Startup removes the CLI token handoff file.
  Cloud/GitHub mode uses the separate `relay_cloud_session` cookie.
- **GitHub** — the browser completes a **GitHub App** code + PKCE flow; the server maps the profile through
  `GitHubAuthProvider` → `DatabaseUserStore` and issues an opaque session token (hashed at rest in `auth_sessions`).
  Non-browser clients send `Authorization: Bearer <token>` (the CLI reads the token handed over to
  `~/.relay/session.json` by a loopback login). Credentials are required in this mode.

`createServices()` returns long-lived services with `localUser` resolved in local mode (null in GitHub mode).
`handleRequest` resolves the caller per request (`resolveRequestUser` in `identity.ts`) and passes
`RequestServices = ServerServices & { user }` to handlers. `/api/health` and `/api/auth/*` are public; every other
`/api/*` route returns 401 when unauthenticated.

### API key

The LLM API key is per user, entered once in the web Settings page, and encrypted at rest under a master key
(`RELAY_SECRET_KEY`/`RELAY_SECRET_KEY_FILE`, or a generated `RELAY_DATA_DIR/secret.key`). The default backend keeps it
in local files (`RELAY_DATA_DIR/settings/<userId>.json`, mode `0600`, AES-GCM with owner-bound AAD); the database
backend stores it encrypted in `user_settings` instead. Startup with the file backend migrates any database keys into
the files and clears them. `getApiKey` is the only plaintext path (used by `RunManager` to build the provider at run
start, never handed to the model); `GET /api/settings` reads a status that never decrypts, exposing only `{ set, hint }`.
A missing key fails the run with a clear message, and `handleSendMessage` returns 400 before a doomed run begins.

### Background state

When the CLI supervisor starts the server it sets `RELAY_STATE_FILE` to the mode-specific path
(`~/.relay/server-local.json` or `server-cloud.json`); once the listener is bound `main.ts` writes
`{ url, port, pid, cwd, webUrl }` (mode `0600`, write-then-rename so readers never see a partial file) so
`relay stop`/`relay status` can find it. A plain `relay serve` leaves no state behind.

The configured port is bound strictly: when it is taken the server prints the conflict (stale server, `relay stop`,
`RELAY_PORT`) and exits with code 75 (`EX_TEMPFAIL`). The CLI supervisor treats that as "another server may be
starting": it adopts a healthy winner, otherwise it reports the bind error. The server never chooses a random port.

## API Surface

| Endpoint                     | Method | Purpose                                               |
| ---------------------------- | ------ | ----------------------------------------------------- |
| `/api/health`                | GET    | Liveness + version + local/cloud flavor               |
| `/api/auth/login`            | GET    | Begin GitHub OAuth (redirect)                         |
| `/api/auth/callback`         | GET    | GitHub OAuth callback                                 |
| `/api/auth/logout`           | POST   | Revoke the session + clear the cookie                 |
| `/api/me`                    | GET    | Authenticated user                                    |
| `/api/config`                | GET    | Model + context window for status displays            |
| `/api/settings`              | GET    | Per-user API-key presence (masked)                    |
| `/api/settings/api-key`      | PUT    | Set or clear the caller's LLM API key                 |
| `/api/workspace`             | GET    | Server default cwd                                    |
| `/api/workspaces`            | GET    | Distinct workspaces (cwds) with session counts        |
| `/api/workspaces`            | POST   | Validate + register a workspace                       |
| `/api/workspaces`            | DELETE | Hide a workspace (sessions kept; re-add or a new session restores it) |
| `/api/workspaces/validate`   | GET    | Validate a candidate cwd without registering it       |
| `/api/sessions?cwd=`         | GET    | Session summaries for a workspace                     |
| `/api/sessions`              | POST   | Create session                                        |
| `/api/sessions/:id`          | GET    | Open (header, entries, tokens, cost, branch, running) |
| `/api/sessions/:id/messages` | POST   | Submit user message (starts a run)                    |
| `/api/sessions/:id/approve`  | POST   | Resolve pending approval                              |
| `/api/sessions/:id/cancel`   | POST   | Abort active run                                      |
| `/api/sessions/:id/events`   | GET    | SSE stream                                            |
| `/api/sessions/:id/files`    | GET    | Project file listing                                  |
| `/api/boxes`                 | GET    | List the caller's boxes + capacity                    |
| `/api/boxes`                 | POST   | Create a standalone box (optional cwd/profile)        |
| `/api/boxes/:id`             | GET    | Box status                                            |
| `/api/boxes/:id/attach`      | POST   | Attach a session                                      |
| `/api/boxes/:id/detach`      | POST   | Detach a session                                      |
| `/api/boxes/:id/resize`      | POST   | Live-resize to tiny/small/medium                      |
| `/api/boxes/:id/pause`       | POST   | Pause an idle box (services stay warm)                |
| `/api/boxes/:id/resume`      | POST   | Resume a paused box                                   |
| `/api/boxes/:id/stop`        | POST   | Stop an idle box                                      |
| `/api/boxes/:id`             | DELETE | Detach attachments and remove the box                 |

Payload types live in `@vvtxn/client/protocol.ts` — never redeclare them here. Box routes are owner-checked through
`ownedBox`; only the box owner may inspect or control it. `GET /api/sessions/:id` includes the attached `box` summary
when boxes are enabled.

## Environment

- `LLM_BASE_URL`, `LLM_MODEL`, `LLM_TEMPERATURE`, `LLM_MAX_TOKENS`, `LLM_MAX_COMPLETION_TOKENS`
- Flavor: `RELAY_FLAVOR=cloud|local` (default cloud; set by the package scripts). Cloud implies Turso + GitHub;
  local implies SQLite + local auth.
- Cloud required: `TURSO_DB_URL`, `TURSO_DB_TOKEN`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`
  (`GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` still accepted). Local mode ignores them.
- Local: `RELAY_DB_PATH` (default `RELAY_DATA_DIR/relay.db`).
- `RELAY_PUBLIC_URL` (OAuth callback base), `AUTH_SESSION_TTL_DAYS` (default 30)
- Hardening: `RELAY_PUBLIC_URL` (HTTPS), `AUTH_ALLOWED_GITHUB`, and `RELAY_WORKSPACE_ROOTS`; local allows any
  directory, cloud defaults to the server user's home, `*` allows any directory. All three are required for a
  non-loopback cloud host, and `*` is rejected.
- `RELAY_PORT` (default 7433), `RELAY_HOST` (default 127.0.0.1), `RELAY_WORKSPACE`, `RELAY_STATIC_DIR`
- `RELAY_MAX_SESSIONS_PER_WORKSPACE`: persisted sessions kept per owner/workspace; `0` = unlimited (local default),
  cloud default is 10
- Settings storage: `RELAY_SETTINGS_STORE` (`file` default, or `database`), `RELAY_DATA_DIR` (default `~/.relay`),
  `RELAY_SECRET_KEY` / `RELAY_SECRET_KEY_FILE` (master key; required with the database backend)
- Boxes (on by default; `RELAY_BOX=0` disables): `RELAY_BOX_RETENTION_MS` (24h default; applies to stopped boxes
  even while attached), `RELAY_BOX_PROFILE` (`tiny` default), `RELAY_BOX_MAX_PROFILE` (`small`),
  `RELAY_BOX_IMAGE` (`auto` by default; uses `relay-box:local` when loaded), `RELAY_BOX_MAX_RUNNING`,
  `RELAY_BOX_MAX_CPUS`, `RELAY_BOX_MEMORY_BUDGET_MIB`,
  `RELAY_BOX_VM_OVERHEAD_MIB`, `RELAY_BOX_PAUSE_MS`, `RELAY_BOX_STOP_MS`, `RELAY_BOX_RETENTION_MS`,
  `RELAY_BOX_ACQUIRE_TIMEOUT_MS`, `RELAY_BOX_SETUP_TIMEOUT_MS`, `RELAY_BOX_DATA_DIR`, `RELAY_BOX_CACHE_DIR`,
  `RELAY_BOX_SETUP`, `RELAY_BOX_RESUME`, `RELAY_BOX_GITHUB_TOKEN`, `RELAY_BOX_GIT_HOST`

## Running

```bash
pnpm relay serve        # foreground cloud server
pnpm relay:local serve  # foreground local server
```

## Task Completion Checklist

After concluding that a task is complete, always run these commands from the repo root:

1. `pnpm exec vp fmt` — auto-format all code
2. `pnpm check` — format, lint, and type-check (Oxfmt, Oxlint, tsgo via Vite+)

## Code Patterns

- Handlers are Effects returning `HttpServerResponse` (never `async`); route them through `authenticated`/`withCsrf`
- Route handlers fail with `BadRequestError`/`ForbiddenError`/`NotFoundError`/`PayloadTooLargeError`; `respond()` maps
- SSE frames via `encodeSSEFrame` from `@vvtxn/client`; heartbeats via a `Stream.tick`
- Prefer Effect primitives for new server code: `Effect.gen`, `Ref`, `Deferred`, `Queue`, `Stream`, `Schedule`
- `oxlint-disable-next-line` is rarely needed — prefer extracting non-async generators
