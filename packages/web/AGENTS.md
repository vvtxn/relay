# AGENTS.md - Web

Preact SPA served by the Relay server. Built with Vite; state via `@preact/signals`; data via the shared `@vvtxn/client`
(fetch + SSE). No TanStack Query, no router.

## Architecture

```
web/
├── deno.json        # @vvtxn/web; npm imports (preact, @preact/signals, vite) + JSX config
├── package.json     # type: module marker for Vite
├── vite.config.ts   # aliases to client/relay sources, preact JSX via esbuild, dev proxy
├── index.html       # Vite entry
├── dist/            # Build output (gitignored) — served by the server in production
└── src/
    ├── main.tsx     # render(<App />)
    ├── app.tsx      # Layout + boot; the single signal-reading point
    ├── api.ts       # RelayClient singleton (server URL from localStorage)
    ├── state.ts     # All signals + actions: sessions, SSE folding, approvals, boot
    ├── styles.css   # Dark theme (GitHub-dark inspired), one file
    └── components/
        ├── Sidebar.tsx         # Workspace input, session list, new chat, user
        ├── ChatView.tsx        # Message list + in-flight draft + auto-scroll
        ├── MessageView.tsx     # User bubble / agent markdown + tool calls
        ├── ToolCallView.tsx    # Tool card: name, args summary, output, diff
        ├── DiffView.tsx        # parseDiffLines → colored diff lines
        ├── Markdown.tsx        # Safe vdom markdown (no innerHTML)
        ├── Composer.tsx        # Textarea + @-mention file picker + Stop button
        ├── ApprovalDialog.tsx  # allow / always / deny overlay
        └── StatusBar.tsx       # Branch, tokens, cost, user
```

## Key Concepts

### Signal flow

`app.tsx` reads every signal during render (single re-render point); components are pure-prop. `state.ts` owns all
mutations:

- `bootstrap()` — `me` → workspace cwd (localStorage or `GET /api/workspace`) → open most recent session or create one
- `startStream()` — SSE subscription per session with reconnect + exponential backoff; folds events via `foldEvent()`
- `foldEvent()` — mirrors the CLI's draft logic: text deltas and tool calls accumulate in `draftText`/ `draftToolCalls`,
  `turn_complete` flushes them into `messages`, `run_finished` refetches the session so persisted entries are the source
  of truth
- Approvals: `approval_required` opens the dialog; the decision POSTs back; `approval_resolved` clears it

### Markdown

`Markdown.tsx` parses blocks (fences, headings, lists, quotes, hr, paragraphs) and inline (`code`, bold, italic, links)
into Preact vnodes — never `dangerouslySetInnerHTML`, since LLM output is untrusted. No syntax highlighting yet.

### File mentions

Typing `@` in the composer fetches `GET /api/sessions/:id/files` (cached per session), filters as you type, and inserts
`@path` at the cursor. The server expands mentions into `<attached_context>` blocks before the run.

## Building & Running

```bash
deno task web:build      # vite build → packages/web/dist
deno task web:dev        # vite dev server (proxies /api to 127.0.0.1:7433)
deno task serve          # relay server; set RELAY_STATIC_DIR=packages/web/dist to serve the build
```

Server URL can be overridden per browser via localStorage key `relay.serverUrl`.

## Dependencies

- `preact`, `@preact/signals` (npm, via Deno workspace node_modules)
- `vite` (build tool, npm)
- `@vvtxn/client` — protocol + RelayClient
- `@vvtxn/relay/core/display.ts` — `entriesToUIMessages`, `parseDiffLines`, `getToolDisplayName`, `getToolDisplayOutput`
  (browser-pure by design)

## Task Completion Checklist

After concluding that a task is complete, always run these commands from the repo root:

1. `deno task fmt` — auto-format all code
2. `deno task lint` — check for lint errors
3. `deno task test` — run the test suite
4. `deno task web:build` — verify the bundle builds

## Code Patterns

- Only `app.tsx` reads signals in render; keep components pure-prop
- New server capability: extend `@vvtxn/client` first, then `state.ts`, then components
- Buttons always declare `type="button"` (deno lint enforces it)
- Deno lint runs on this package too — keep TSX lint-clean
