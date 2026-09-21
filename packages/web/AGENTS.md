# AGENTS.md - Web

SolidJS SPA served by the Relay server. Built with Vite; REST server state via TanStack Query; routing via TanStack
Router; the SSE stream and domain fold via Effect; shared tokens and display helpers from `@vvtxn/relay`.

## Architecture

```
web/
├── deno.json        # @vvtxn/web; npm imports (solid-js, tanstack, effect, marked, vite) + JSX/lib config
├── package.json     # type: module marker for Vite
├── vite.config.ts   # solid plugin, @vvtxn/* + @/ aliases, /api dev proxy, fs.allow for sibling packages
├── index.html       # Vite entry
├── dist/            # Build output (gitignored) — served by the server in production
└── src/
    ├── main.tsx     # render + apply theme + QueryClientProvider + RouterProvider
    ├── router.tsx   # Code-based routes: "/" boot → "/s/$sessionId"
    ├── theme.ts     # applyTheme(): shared tokens → --relay-* CSS variables
    ├── version.ts   # Display version
    ├── styles.css   # Layout + components, all colors via var(--relay-*)
    ├── api/
    │   ├── client.ts      # RelayClient singleton (credentials: include, localStorage server URL)
    │   ├── storage.ts     # localStorage helpers (server URL, cwd)
    │   ├── services.ts    # Effect Api + SessionStream services, RelayError, AppLayer
    │   ├── runtime.ts     # ManagedRuntime + runApi/fork/interrupt helpers
    │   ├── query-client.ts# QueryClient + query key helpers
    │   ├── queries.ts     # queryOptions for me/config/workspace/sessions/session/files
    │   ├── mutations.ts   # createSession/sendMessage/approve/cancel (Effect-backed)
    │   └── bootstrap.ts   # Effect program: health → me → config → workspace → session
    ├── auth/auth.ts       # OAuth seam: login/logout URLs, redirect helpers
    ├── state/
    │   ├── session.ts     # Live stream store + reconnect fiber + query invalidation
    │   └── workspace.ts   # Active cwd signal (persisted)
    ├── pages/
    │   ├── BootPage.tsx   # Runs bootstrap, seeds query cache, redirects to a session
    │   └── SessionPage.tsx# Hydrates session, starts stream, composes the shell
    └── components/
        ├── Sidebar.tsx         # Workspace input, session list, new chat
        ├── ChatView.tsx        # Message list + in-flight draft + auto-scroll
        ├── MessageView.tsx     # User bubble / agent markdown + tool calls
        ├── ToolCallView.tsx    # Tool card: name, args summary, output, diff
        ├── DiffView.tsx        # parseDiffLines → colored diff lines
        ├── Markdown.tsx        # marked tokens → Solid vnodes (no innerHTML)
        ├── Composer.tsx        # Textarea + @-mention picker + send/stop
        ├── ApprovalDialog.tsx  # allow / always / deny overlay
        ├── StatusBar.tsx       # Branch, tokens, cost, user, sign out
        └── BootScreen.tsx      # Loading / error / login screens
```

## Key Concepts

### Effect owns the stream, TanStack owns the request cache

- `api/services.ts` wraps `RelayClient` in two Effect services: `Api` (REST as `Effect<A, RelayError>`) and
  `SessionStream` (SSE as `Stream<ServerEvent, RelayError>`). `AppLayer` provides both; `api/runtime.ts` holds the
  single `ManagedRuntime`.
- `api/queries.ts` / `api/mutations.ts` run those Effect programs into Promise-returning TanStack functions. Query owns
  caching, dedup, retries, and invalidation for REST; it does **not** cache the live stream.
- `state/session.ts` forks a reconnect loop onto the runtime: consume the stream, and on end/failure back off (500ms →
  5s) and resubscribe. The fiber is interrupted on navigation. Every event is folded with `applyServerEvent` from
  `@vvtxn/client/session-state.ts` into a Solid signal.
- `run_finished` invalidates the session + sessions queries so persisted entries replace the live view.

### Boot flow

`api/bootstrap.ts` is an Effect program: health-check (`Cannot reach the Relay server at ...`), load identity + config,
resolve cwd (localStorage or `GET /api/workspace`), then open the most recent session or create one. `BootPage` runs it
via `createResource`, seeds the Query cache, and redirects to `/s/$sessionId`.

### Auth (GitHub OAuth)

`api/client.ts` sends `credentials: "include"` on every request so the session cookie flows automatically. `bootstrap`
treats a 401 as a first-class `{ kind: "unauthenticated" }` outcome; `BootPage` renders `LoginScreen`, which reads the
public `/api/auth/info` query and links to `/api/auth/login` (label "Continue with GitHub"). `SessionPage` redirects to
`/` on a 401 or a missing/foreign session. `auth/auth.ts` centralizes the login/logout URLs (`VITE_RELAY_LOGIN_URL` /
`VITE_RELAY_LOGOUT_URL`, defaulting to `/api/auth/*`). `MeResponse.avatarUrl` is shown in the status bar and sidebar. No
client changes are needed when the server switches between local and GitHub auth.

### Theming

`packages/relay/core/theme.ts` is the single source of tokens; the CLI re-exports it from `@/tui/theme.ts`. `theme.ts`
here calls `themeToCssVariables()` and applies `--relay-*` custom properties to `document.documentElement` at startup.
`styles.css` only references those variables — never hardcode colors.

### Markdown

`Markdown.tsx` lexes with `marked` and renders tokens to Solid elements. Raw HTML is rendered as text and links use
`rel="noreferrer noopener"` — LLM output is untrusted and is never injected via `innerHTML`.

### File mentions

Typing `@` in the composer opens a picker backed by `GET /api/sessions/:id/files` (TanStack query). Selecting a file
inserts `@path`; the server expands mentions into `<attached_context>` blocks before the run.

## Building & Running

```bash
deno task web:dev        # Vite dev server (proxies /api to 127.0.0.1:7433)
deno task web:build      # vite build → packages/web/dist
deno task serve:prod     # serve the built SPA (production env; RELAY_STATIC_DIR set)
```

Server URL defaults to same-origin (`""`), so dev requests go through the Vite `/api` proxy and production requests hit
the server that serves the SPA. Override it per browser via the localStorage key `relay.serverUrl` to point at a
different server (which must then allow this browser origin). The legacy absolute default is treated as unset.

## Dependencies

- `solid-js` (1.x), `@tanstack/solid-query`, `@tanstack/solid-router` (npm)
- `effect` (v3) — services, layers, streams, runtime, typed errors
- `marked` — markdown lexer (rendered safely to vnodes)
- `vite` + `vite-plugin-solid` (build)
- `@vvtxn/client` — protocol, RelayClient, shared session-state reducer
- `@vvtxn/relay` — `display.ts` helpers and `theme.ts` tokens (browser-pure)

## Task Completion Checklist

After concluding that a task is complete, always run these commands from the repo root:

1. `deno task fmt` — auto-format all code
2. `deno task lint` — check for lint errors
3. `deno task check` — strict type-check of every entrypoint
4. `deno task test` — run the test suite
5. `deno task web:build` — verify the bundle builds

## Code Patterns

- REST server state belongs in TanStack Query; live run state belongs in the session stream store
- Extend `@vvtxn/client` first when a new server capability is needed, then the Effect `Api`, then components
- Fold logic lives in `@vvtxn/client/session-state.ts` — never reimplement draft handling in the web app
- Buttons always declare `type="button"` (deno lint enforces it)
- Use `globalThis.location` rather than `window` (deno lint's `no-window`)
- Deno lint runs on this package too — keep TSX lint-clean
