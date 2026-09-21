# AGENTS.md - Server

HTTP + SSE server hosting the Relay agent runtime. Plain TypeScript on `Deno.serve` — no web framework.

## Architecture

```
server/
├── deno.json        # @vvtxn/server; exports "./main" for the CLI serve subcommand
├── mod.ts           # Public exports (startServer, createServices, handleRequest, RunManager)
├── main.ts          # Entry point: config from env → createServices → Deno.serve
├── config.ts        # serverConfigFromEnv: port, host, LLM key/model, Turso, auth, static dir
├── services.ts      # ServerServices + createServices() — the composition seam
├── router.ts        # Manual route matching; per-request auth gate; error mapping (400/401/404/405/500)
├── identity.ts      # Per-request user resolution (cookie/bearer/local bridge)
├── auth-routes.ts   # /api/auth/info|login|callback|logout (GitHub OAuth)
├── github-oauth.ts  # GitHub authorize/token/profile calls + PKCE
├── cookies.ts       # Cookie parse/serialize helpers
├── http.ts          # json()/error() helpers, readJsonBody, BadRequest/NotFound errors
├── sessions.ts      # /api/me, /api/config, session CRUD, message submission
├── run.ts           # RunManager: one active run per session, SSE fan-out, approvals
├── approvals.ts     # /api/sessions/:id/approve + /cancel handlers
├── sse.ts           # GET /api/sessions/:id/events (snapshot + live stream + heartbeat)
├── files.ts         # GET /api/sessions/:id/files (project file listing for @-mentions)
├── workspace.ts     # GET /api/workspace (server default cwd)
├── static.ts        # Static web app serving with SPA fallback + path confinement
├── config.test.ts   # Config parsing tests
├── identity.test.ts # Per-request auth resolution tests
└── run.test.ts      # RunManager tests (fake store/provider)
```

## Key Concepts

### Composition seam (`services.ts`)

`createServices(config)` builds every long-lived service once and returns a plain `ServerServices` object that each
route handler receives as a parameter. There is no module-level hidden state — this is the Effect-ready boundary: each
field can later become an Effect Layer without touching handlers.

### RunManager (`run.ts`)

Owns active runs, one per session:

- `startMessage()` claims the slot synchronously (409-equivalent via `RunConflictError`) then runs the agent loop in the
  background; concurrent submits are rejected
- Bridges runner callbacks to `ServerEvent`s fanned out to per-session SSE subscribers
- Tracks in-flight draft state (text, tool calls, results) for `run_state` snapshots sent to late subscribers
- Gates side-effecting tools via `withApproval`: pending approvals live in a map, decisions arrive via
  `resolveApproval()`, and the handler races the run's AbortSignal (mirrors the CLI pattern)
- "always allow" is per session, in memory
- Persists assistant/tool entries on `turn_complete` and token/cost on the session handle; flushes on run end
- Denies any still-pending approvals in `finally` so promises never leak

### Sessions

The database store inserts sessions lazily (on first append), so sessions created in-process are not yet visible to
`store.open()`. All session routes go through `openSessionHandle()` (sessions.ts): try the store, fall back to the live
RunManager handle.

The per-session workspace cwd comes from the client (CLI sends its terminal cwd). File tools are confined to that cwd;
bash is not (documented in relay core AGENTS.md).

### Auth

`AUTH_PROVIDER` selects the mode:

- `local` (default) — every request resolves to `LocalAuthProvider(DEV_AUTH_SUBJECT)`; no cookies. The CLI works
  unchanged.
- `github` — the browser completes a **GitHub App** user-authorization code + PKCE flow (permissions live on the App, so
  no `scope` is sent); the server maps the GitHub profile through `GitHubAuthProvider` → `DatabaseUserStore` and issues
  an **opaque session token** (hashed at rest in `auth_sessions`), set as an `HttpOnly; SameSite=Lax` cookie. The CLI
  can authenticate with `Authorization: Bearer <token>` or, when `AUTH_ALLOW_LOCAL=true`, the `X-Relay-Local-Subject`
  header.

`createServices()` returns long-lived services **without** a user. `handleRequest` resolves the caller per request
(`identity.ts`) and passes `RequestServices = ServerServices & { user }` to handlers. `/api/health` and `/api/auth/*`
are public; every other `/api/*` route returns 401 when unauthenticated. GitHub identity mapping and the session store
are the only new storage — sessions are already scoped by `ownerId`.

### API key

`LLM_API_KEY` env wins; otherwise the CLI's `~/.relay/auth.json` is read (injectable reader for tests).

### Static serving

`RELAY_STATIC_DIR` enables serving a static directory with SPA fallback (index.html for unknown paths). Paths are
confined to the static dir.

## API Surface

| Endpoint                     | Method | Purpose                                               |
| ---------------------------- | ------ | ----------------------------------------------------- |
| `/api/health`                | GET    | Liveness + version                                    |
| `/api/auth/info`             | GET    | Public auth provider + login URL                      |
| `/api/auth/login`            | GET    | Begin login (GitHub redirect, or `/` in local mode)   |
| `/api/auth/callback`         | GET    | GitHub OAuth callback                                 |
| `/api/auth/logout`           | POST   | Revoke the session + clear the cookie                 |
| `/api/me`                    | GET    | Authenticated user                                    |
| `/api/config`                | GET    | Model + context window for status displays            |
| `/api/workspace`             | GET    | Server default cwd                                    |
| `/api/sessions?cwd=`         | GET    | Session summaries for a workspace                     |
| `/api/sessions`              | POST   | Create session                                        |
| `/api/sessions/:id`          | GET    | Open (header, entries, tokens, cost, branch, running) |
| `/api/sessions/:id/messages` | POST   | Submit user message (starts a run)                    |
| `/api/sessions/:id/approve`  | POST   | Resolve pending approval                              |
| `/api/sessions/:id/cancel`   | POST   | Abort active run                                      |
| `/api/sessions/:id/events`   | GET    | SSE stream                                            |
| `/api/sessions/:id/files`    | GET    | Project file listing                                  |

Payload types live in `@vvtxn/client/protocol.ts` — never redeclare them here.

## Environment

- `LLM_API_KEY` (or `~/.relay/auth.json` fallback), `LLM_BASE_URL`, `LLM_MODEL`, `LLM_TEMPERATURE`, `LLM_MAX_TOKENS`,
  `LLM_MAX_COMPLETION_TOKENS`
- `TURSO_DB_URL`, `TURSO_DB_TOKEN`
- `AUTH_PROVIDER` (`local` default, or `github`); `DEV_AUTH_SUBJECT` (required for local)
- GitHub App mode: `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` (`GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` still
  accepted), `RELAY_PUBLIC_URL` (OAuth redirect base), `AUTH_SESSION_TTL_DAYS` (default 30), `AUTH_ALLOW_LOCAL` (CLI
  bridge; loopback-only; keep `false` in production)
- Hardening: `AUTH_ALLOWED_GITHUB` (logins/ids allowed to sign in), `RELAY_WORKSPACE_ROOTS` (allowed session cwd roots)
- `RELAY_PORT` (default 7433), `RELAY_HOST` (default 127.0.0.1), `RELAY_WORKSPACE`, `RELAY_STATIC_DIR`

## Running

```bash
deno task serve:dev      # from repo root, loads development env files
deno task serve:prod     # production env files
relay serve              # compiled binary subcommand (runtime env)
```

## Task Completion Checklist

After concluding that a task is complete, always run these commands from the repo root:

1. `deno task fmt` — auto-format all code
2. `deno task lint` — check for lint errors
3. `deno task check` — strict type-check of every entrypoint
4. `deno task test` — run the test suite

## Code Patterns

- Handlers receive `services` explicitly; never read env at request time
- Route handlers throw `BadRequestError`/`NotFoundError`; the router maps them to responses
- SSE frames via `encodeSSEFrame` from `@vvtxn/client`; heartbeats as SSE comments every 15s
- `deno-lint-ignore` is rarely needed — prefer extracting non-async generators
- Tests use fake stores/providers (see `run.test.ts`), never a live database
