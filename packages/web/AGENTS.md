# AGENTS.md - Web

SolidJS SPA served by the Relay server. Built with Vite+ (Vite); REST server state via TanStack Query; routing via TanStack
Router; the SSE stream and domain fold via Effect; shared tokens and display helpers from `@vvtxn/relay`.

## Architecture

```
web/
├── package.json     # @vvtxn/web; deps + #/ imports (JSX/lib config lives in tsconfig.json)
├── tsconfig.json    # solid JSX settings, DOM libs
├── vite.config.ts   # solid plugin, @vvtxn/* aliases, /api dev proxy, fs.allow for sibling packages
├── index.html       # Vite entry
├── dist/            # Build output (gitignored) — served by the server in production
└── src/
    ├── main.tsx     # render + apply theme + QueryClientProvider + RouterProvider
    ├── router.tsx   # Code-based routes: "/" boot → "/s/$sessionId" (+ its "/settings" overlay)
    ├── theme.ts     # applyTheme(mode): palette + color-scheme → --relay-* CSS variables
    ├── version.ts   # Display version
    ├── highlight.ts # Shared Shiki bridge (lazy grammars; pierre-dark/light, light-dark())
    ├── styles.css   # Layout + components, all colors via var(--relay-*)
    ├── api/
    │   ├── client.ts      # RelayClient singleton (credentials: include, localStorage server URL)
    │   ├── storage.ts     # localStorage helpers (server URL, cwd, session id)
    │   ├── runtime.ts     # ManagedRuntime over @vvtxn/client's appLayer + runApi/fork/interrupt helpers
    │   ├── query-client.ts# QueryClient + query key helpers
    │   ├── queries.ts     # queryOptions for me/config/workspace/workspaces/sessions/session/files
    │   ├── mutations.ts   # createSession/sendMessage/approve/cancel (Effect-backed)
    │   └── bootstrap.ts   # Effect program: health → me → config → workspace → session
    ├── auth/auth.ts       # OAuth seam: login/logout URLs, redirect helpers
    ├── state/
    │   ├── session.ts     # Live stream store (survives navigation) + reconnect fiber + query invalidation
    │   ├── workspace.ts   # Active cwd signal (persisted)
    │   ├── diff-preview.ts # Diff open in the review modal (module-level; survives chat re-renders)
    │   └── theme.ts       # Palette preference (persisted; dark default)
    ├── pages/
    │   ├── BootPage.tsx   # Runs bootstrap, seeds query cache, redirects to a session
    │   ├── SessionPage.tsx# Hydrates session, starts stream, composes the shell
    │   └── SettingsPage.tsx # Account + appearance + API key; overlay under `/s/:id` and standalone `/settings`
    └── components/
        ├── Sidebar.tsx         # Workspace switcher, session list, new chat
        ├── ChatView.tsx        # Message list + in-flight draft + auto-scroll
        ├── MessageView.tsx     # Turn with an `info` (user) or `brand` (agent) left border, tool panel below
        ├── Markdown.tsx        # markdown-it token stream → Solid vnodes (no innerHTML)
        ├── CodeBlock.tsx       # Fenced code block highlighted by the shared Shiki instance
        ├── ToolCalls.tsx       # Per-call rows: tool accents, grep matches, output previews
        ├── DiffBlock.tsx       # Unified diffs via @pierre/diffs (plain-line fallback)
        ├── DiffModal.tsx       # Review modal (native dialog, showModal) for one edit/write diff, scrollable
        ├── Composer.tsx        # Textarea + @-mention picker + send/stop
        ├── ApprovalDialog.tsx  # allow / always / deny overlay
        ├── StatusBar.tsx       # Branch, tokens, cost, user, sign out
        └── BootScreen.tsx      # Loading / error / login screens
```

## Key Concepts

### Effect owns the stream, TanStack owns the request cache

- `@vvtxn/client/services.ts` wraps `RelayClient` in two Effect services: `Api` (REST as `Effect<A, RelayError>`) and
  `SessionStream` (SSE as `Stream<ServerEvent, RelayError>`). `appLayer(client)` provides both; the web's
  `api/runtime.ts` installs it (with the browser-configured client) into the single `ManagedRuntime`.
- `api/queries.ts` / `api/mutations.ts` run those Effect programs into Promise-returning TanStack functions. Query owns
  caching, dedup, retries, and invalidation for REST; it does **not** cache the live stream.
- `state/session.ts` forks a reconnect loop onto the runtime: consume the stream, and on end/failure back off (500ms →
  5s) and resubscribe. Every event is folded with `applyServerEvent` from `@vvtxn/client/session-state.ts` into a
  module-level Solid signal.
- The session route's loader (`router.tsx`) `ensureQueryData`s the persisted snapshot before rendering; with
  `defaultPreload: "intent"` link hovers warm it. `ensureSession(id, snapshot)` seeds the store only on the first entry
  per session, and `startStream(id)` is idempotent — refetches and re-renders never reset live state or restart the
  stream. The fiber is interrupted only when the session route unmounts.
- `run_finished` invalidates the session + sessions queries so persisted entries replace the live view.

### Navigation performance

TanStack Router commits navigation inside a Solid transition, and Solid holds a transition open until every query
resource created during it settles — an eagerly fetching `useQuery` on mount therefore delays *any* navigation by a
round trip. Keep these rules in mind:

- The session route's loader (`router.tsx`) fetches a **fresh** snapshot (`fetchQuery` +
  `staleReloadMode: "blocking"`), so a stale router/query cache never paints; a just-created or still-streamed session
  resolves from cache with no request.
- `BootPage` seeds me/config/sessions/workspaces into the query cache and prefetches settings, so the first session
  render needs no fetches.
- Queries not needed for first paint stay lazy: the mention file list is only enabled while the picker is open
  (prefetched on composer focus).
- Leaving a session stops its stream and invalidates that snapshot, so returning to it always refetches — the stream is
  the only witness of events while detached. The previous view stays on screen while the loader resolves.
- `defaultPreload: "intent"` warms session loaders and workspace session lists on hover.

### Boot flow

`api/bootstrap.ts` is an Effect program: health-check (`Cannot reach the Relay server at ...`), load identity, then fetch
config + the default workspace + validate the persisted workspace in parallel, then open the most recent session or
create one. `BootPage` runs it via `createResource`, seeds the Query cache, and redirects to `/s/$sessionId`.

### Auth (GitHub OAuth)

`api/client.ts` sends `credentials: "include"` on every request so the session cookie flows automatically. `bootstrap`
treats a 401 as a first-class `{ kind: "unauthenticated" }` outcome; `BootPage` renders `LoginScreen`, a "Continue with
GitHub" button linking to `/api/auth/login`. The session route's loader redirects to `/` for a missing, foreign, or
unauthorized session (the page keeps a redirect effect as a backstop). `auth/auth.ts` centralizes the login/logout URLs
(`VITE_RELAY_LOGIN_URL` / `VITE_RELAY_LOGOUT_URL`, defaulting to `/api/auth/*`). `MeResponse.avatarUrl` is shown in the
status bar and sidebar.

### Theming

`packages/relay/core/theme.ts` is the single source of tokens; the CLI re-exports it from `@/tui/theme.ts`. It exports
`lightTheme` alongside the dark default plus a `themes` map. `theme.ts` here calls `themeToCssVariables(themes[mode])`,
applies `--relay-*` custom properties and `color-scheme` to `document.documentElement`, and tags `data-theme`.
`state/theme.ts` holds the persisted preference (localStorage key `relay.theme`, dark default) and is applied before the
first render in `main.tsx`; `styles.css` only references those variables — never hardcode colors.

Typography is shared too: `packages/relay/core/fonts.ts` names the family and CSS stack, and `styles.css` declares
`@font-face` rules for the woff2 files under `packages/relay/assets/fonts` (Vite copies them into the bundle). Startup
sets `--relay-font-mono` from `font.cssStack`; the value in `:root` is only a no-JS fallback. The terminal installs the
same font via `relay fonts install` — see `packages/relay/assets/fonts/README.md` before swapping it.

### Settings (`/s/:sessionId/settings` and `/settings`)

`pages/SettingsPage.tsx` renders one auth-guarded `SettingsPanel` with grouped sections: **Account** (identity from
`/api/me`, sign out), **Appearance** (dark/light switch, applied instantly and persisted locally), and **API key**. The
key is per-user, stored in the server database, and the only place a key is entered; `GET /api/settings` returns just
`{ set, hint }` and the page never echoes the key back.

In-app entry points (sidebar chip, status bar) open the **nested overlay** `/s/:sessionId/settings`: the chat stays
mounted and its stream connected behind it, so opening/closing settings is instant and nothing is lost. The standalone
`/settings` route serves CLI deep links (the CLI blocks until a key is set) and returns to the last opened session
(`relay.sessionId` in localStorage) or the boot flow.

### Markdown and code highlighting

`Markdown.tsx` lexes with `markdown-it` (`html: false`) and walks the token stream into Solid elements — raw HTML is
rendered as text and links use `rel="noreferrer noopener"`, because LLM output is untrusted and is never injected via
`innerHTML`. A small core rule adds GFM task-list checkboxes, and fenced blocks become `CodeBlock.tsx` components.

`highlight.ts` owns the one Shiki instance: it borrows `@pierre/diffs`' shared highlighter (JavaScript regex engine, no
WASM; any bundled grammar resolved lazily on first use) with the `pierre-dark` / `pierre-light` themes. Tokens are
highlighted once with `defaultColor: "light-dark()"`, so switching the app palette needs no re-highlight. Unknown
languages stay plain text.

### Messages and tool calls

Turn rendering is a web-native take on the terminal client: user turns carry an `info` left border, agent turns
`brand`, turns are separated by the chat gap, and tool activity is the only element on a background (`surface`) panel.
Turns that run tools drop the `brand` stripe and its padding, so only their per-tool accents show.
Each tool call is a single collapsed row — per-tool accent border (from the shared theme's `toolRead`, `toolWrite`, …
tokens), display name, argument, and a short result stat (`3 matches in 2 files`, `+4 −3`, `40 lines`, `error`, or a
pulsing `running…`). Clicking a row expands the full result: edit/write diffs render through `@pierre/diffs` (see
`DiffBlock.tsx`; falls back to `parseDiffLines` coloring when a patch cannot be parsed), grep output is split into
colored file/line/text, and other results show as preformatted text. Collapsed by default is deliberate — long outputs
stay one line unless the reader asks for them. Edit and write calls that produced a diff also get a **View diff**
button beside the row. It opens `DiffModal.tsx`, a native modal `<dialog>` with the full diff in a scrollable body;
Escape, the Close button, or a backdrop click dismisses it. Its state lives in `state/diff-preview.ts`, outside the
message list, so streamed deltas cannot close it.

### File mentions

Typing `@` in the composer opens a picker backed by `GET /api/sessions/:id/files` (TanStack query, enabled only while
the picker is open; the composer prefetches it on focus). Selecting a file inserts `@path`; the server expands mentions
into `<attached_context>` blocks before the run.

### Workspaces

A workspace is a project directory. `GET /api/workspaces` returns the distinct session `cwd`s plus explicitly registered
workspaces (and the server default) for the user. The sidebar renders them as an expandable **tree**: each workspace is
a row with a chevron, session count, and a `missing` flag when its directory is gone; its sessions nest underneath. Only
expanded workspaces are fetched (`useQueries` over `sessionsQuery(cwd)` per open cwd), and the active workspace is
always expanded. Selecting a workspace scopes the "New chat" target (`cwd` in `state/workspace.ts`, persisted) and
drives the session queries. "Add workspace" accepts an absolute path, calls `GET /api/workspaces/validate` (inline error
when missing/outside roots), stores the returned canonical path, and registers it via `POST /api/workspaces`. Bootstrap
re-validates the persisted cwd and falls back to the server default.

## Building & Running

```bash
pnpm web:dev        # Vite dev server (proxies /api to 127.0.0.1:7433)
pnpm web:build      # vite build → packages/web/dist
pnpm serve:prod     # serve the built SPA (production env; RELAY_STATIC_DIR set)
```

Server URL defaults to same-origin (`""`), so dev requests go through the Vite `/api` proxy and production requests hit
the server that serves the SPA. Override it per browser via the localStorage key `relay.serverUrl` to point at a
different server (which must then allow this browser origin). The legacy absolute default is treated as unset.

## Dependencies

- `solid-js` (1.x), `@tanstack/solid-query`, `@tanstack/solid-router` (npm)
- `effect` (v4) — services, layers, streams, runtime, typed errors
- `markdown-it` — markdown lexer (rendered safely to vnodes)
- `shiki` — syntax highlighting; the shared instance also colors code in diffs
- `@pierre/diffs` — Shiki-based unified diff rendering for edit/write tool calls
- `vite-plugin-solid` — Solid compiler plugin; Vite itself comes from `vite-plus`
- `@vvtxn/client` — protocol, RelayClient, shared session-state reducer
- `@vvtxn/relay` — `display.ts` helpers and `theme.ts` tokens (browser-pure)

## Task Completion Checklist

After concluding that a task is complete, always run these commands from the repo root:

1. `pnpm exec vp fmt` — auto-format all code
2. `pnpm check` — format, lint, and type-check (Oxfmt, Oxlint, tsgo via Vite+)
3. `pnpm web:build` — verify the bundle builds

## Code Patterns

- REST server state belongs in TanStack Query; live run state belongs in the session stream store
- Extend `@vvtxn/client` first when a new server capability is needed, then the Effect `Api`, then components
- Fold logic lives in `@vvtxn/client/session-state.ts` — never reimplement draft handling in the web app
- Buttons always declare `type="button"` (`react/button-has-type` in Oxlint)
- Prefer `globalThis.location` over `window` for consistency
- `vp check` runs on this package too — keep TSX lint-clean and type-clean
