# Effect Migration Plan — server, core, client, CLI

Status: proposal · Target: Effect 4.0.4 across the monorepo

Effect currently runs only in `packages/web`. This plan makes it the standard runtime for async work, concurrency,
lifecycle, and error handling in **all four remaining packages** — `server`, `relay` core, `client`, and `cli` — without
touching the wire protocol or the browser-pure modules that web imports.

The migration is deliberately sequenced so that every phase is independently shippable and revertable. Phases 5–6
(client, CLI) sit behind a decision gate: they proceed only if the server/core work proves the pattern out in
production use.

## Current state

| Package    | Effect today                                                    | Role                                           |
| ---------- | --------------------------------------------------------------- | ---------------------------------------------- |
| `web`      | Full: services, `ManagedRuntime`, fiber reconnect loop           | Solid client; already the reference pattern    |
| `server`   | None. `services.ts` is documented as the "Effect-ready boundary" | HTTP + SSE host of the runtime                 |
| `relay`    | None                                                            | Agent loop, tools, sessions, node-side helpers |
| `client`   | None (plain Promise transport)                                  | Wire protocol + `RelayClient`                  |
| `cli`      | None (signals + TUI)                                            | Terminal client; only imports `startServer`    |

Pain points that motivate the refactor, in order of value:

1. **`RunManager`** manages ~8 mutable maps, `AbortController`s, callback subscriber sets, promise-based approvals, and
   a `finally` block that hand-cleans everything. This is textbook structured-concurrency territory (fibers, `PubSub`,
   `Deferred`, `Ref`, finalizers).
2. **The agent loop** hand-rolls retries (regex-gated `isRetryableError` + `setTimeout` backoff), stream timeouts
   (`Promise.race`), and abort checks. `Schedule`, `Stream.timeout`, and interruption make these declarative.
3. **Error mapping** is an `instanceof` chain in the router; core throws plain `Error` with string messages.
4. **Composition**: `createServices` builds DB stores and awaits readiness sequentially; handlers receive them by
   parameter. The seam was designed for Layers.

### Hard constraints (must survive every phase)

- **Wire protocol is frozen**: `@vvtxn/client/protocol.ts`, HTTP routes, SSE frame format, and `startServer()`'s entry
  contract (CLI imports only this) do not change. This is an internal refactor.
- **Browser purity**: web imports `@vvtxn/relay/core/display.ts`, `theme.ts`, `fonts.ts` directly. These and everything
  they transitively import must never gain an `effect` or `node:*` dependency. Effect goes into node-side core, never
  into that subset.
- **Node-native TS**: `packages/relay` and `packages/server` run unbundled under Node's type stripping
  (`node packages/server/main.ts`). Runtime imports in server-reachable files stay **relative** (no `#/`), and no
  enums/namespaces/parameter properties. Effect code is plain generators — compatible.
- **Exit-code contract**: EADDRINUSE ⇒ exit code 75, relied on by the CLI supervisor. Phase 4 must preserve it
  explicitly (inspect `ServeError.cause`).

## Target architecture

- **One `ManagedRuntime` per long-lived process.** Web already has one. Server gets one; CLI gets one in phase 6.
  `relay` core and `client` are libraries: they *expose* Effects/Streams/Layers but never own or run a runtime.
- **Server**: Layers for all composition; HTTP served by `effect/http` (`HttpRouter`, `HttpServer`,
  `HttpServerResponse.stream`) with `NodeHttpServer` from `@effect/platform-node` (v4 does not have a standalone
  `@effect/platform` for the server: HTTP lives in `effect/http`, Node bindings in `@effect/platform-node`).
- **Core**: provider `stream()` becomes `Stream`; `agent.run()` becomes `Stream<AgentEvent, AgentError>`; tools execute
  as `Effect<ToolResult, ToolError>`; retries via `Schedule.exponential`; timeouts via `Stream.timeout`.
- **Client**: `protocol.ts` and the raw `RelayClient` Promise API stay plain. The Effect `Api`/`SessionStream` service
  layer that currently lives in web **moves into `@vvtxn/client`**, so web stops duplicating it and the CLI inherits it.
  `session-state.ts` stays a pure reducer.
- **CLI**: effect-backed runtime for its async/data layer (requests, SSE consumption, approvals, supervisor
  start/stop); TUI signals and renderer untouched.
- **Error handling**: tagged errors at every boundary (`Data.TaggedError`), mapped once per interface — router →
  HTTP status, runner → `run_finished` reason, CLI → inline error.

## Testing strategy — temporary scaffolding

The repo deliberately carries no tests. This migration reintroduces tests as **scaffolding**, not permanent coverage:

- **TDD order per module**: characterization tests first (they must pass against the *current* implementation), then
  the refactor. New behavior gets red→green tests first.
- **Temporary by default**: every test file starts with `// TEMP(effect-migration): remove after phase N` and lives in
  `packages/<pkg>/test/` so a phase's scaffolding can be deleted as one directory. A phase may nominate individual
  tests for retention only with a one-line justification in its PR ("guards non-obvious lifecycle semantics"). Do not
  keep tests that restate implementation details, snapshots of display formatting, or pure helper unit tests — that was
  the noise that got removed before.
- **Behavior over structure**: black-box HTTP tests via `handleRequest` (this signature can be preserved even after the
  platform migration is internal, via a web-handler adapter) and layer-level tests for `RunManager`/agent semantics.
  Later phases can use `NodeHttpServer.layerTest` (ephemeral port + Fetch client) for end-to-end tests.
- **Fakes over mocks**: scripted fake provider (`stream()` yields canned chunks), in-memory session store, `TestClock`
  so retry/backoff tests run instantly. `@effect/vitest@4.0.4` provides `it.effect`/`it.layer`.
- **Small surface**: a phase keeps at most a handful of test files. Coverage targets: run conflict/cancel, approval
  allow/always/deny/deny-on-end, retry classification, stream timeout, loop detection, auth gate, SPA fallback vs API
  404, EADDRINUSE exit.
- **Phase exit smoke**: because the suite is intentionally thin, each phase ends with a manual smoke of `pnpm relay`
  (TUI send/approve/cancel), `pnpm relay web` (stream reconnect), and `pnpm relay stop/status`.

## Phases at a glance

| # | Phase                              | Package(s)     | Big-ticket moves                                                  | Exit criteria                                             |
| - | ---------------------------------- | -------------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| 0 | Baseline & scaffolding             | tooling        | version alignment, vitest wiring, characterization tests          | tests green on current code                               |
| 1 | Composition → Layers               | server         | DB/stores/RunManager as Layers, process `ManagedRuntime`          | identical behavior, services built by layers              |
| 2 | RunManager → structured concurrency | server (+core) | fiber per run, `PubSub`, `Deferred`, `Ref`, interrupt-fold       | all RunManager semantics preserved, approvals auto-deny   |
| 3 | Core runtime                       | relay          | provider/agent → `Stream`, tools → `Effect`, `Schedule` retries   | same `AgentEvent` sequence, typed errors, TestClock green |
| 4 | HTTP → effect/http + platform-node | server         | `HttpRouter`, SSE as stream, `HttpStaticServer` (spa), state file | route/status parity, exit 75 preserved, adapter deleted   |
| 5 | Client Effect layer                | client + web   | move web's `Api`/`SessionStream` into client, dedupe web          | web unchanged visually, CLI can adopt services            |
| 6 | CLI runtime                        | cli            | `ManagedRuntime` for data layer, fibers for SSE/approvals         | TUI behavior unchanged, bundle builds                     |
| 7 | Cleanup & standardize              | all            | prune scaffolding, AGENTS.md boundaries, delete dead docs         | `pnpm build`, `pnpm check`, smoke flows green             |

---

### Phase 0 — Baseline & scaffolding

- Bump `effect` to `4.0.4` in web; add `effect@4.0.4` and `@effect/platform-node@4.0.4` to `packages/server`, `effect`
  to `packages/relay`. Add `@effect/vitest@4.0.4` as a dev dependency where tests live.
- Wire Vitest 5 (already in the toolchain transitively) with a root config; co-locate a `test/` folder per package.
- Characterization tests, run against **current** code:
  - `handleRequest`: health, unauthenticated 401, origin/CSRF rejection, session route happy paths, 404/405 mapping
    (build a fake `ServerServices`: in-memory stores, stub provider).
  - `RunManager`: concurrent submit ⇒ conflict; cancel mid-run; approval allow / always / deny; deny-pending-on-end;
    handle release when idle.
  - Agent loop (fake provider): retryable vs non-retryable failure, stream timeout, repeated-call loop detection,
    readonly-parallel vs side-effect-sequential tool ordering.

Exit: suite green on the unmodified implementation; CI runs it. **These tests are scaffolding**: they exist so the
next six phases can move fast.

### Phase 1 — Server composition as Layers

- `ServerConfig` provided as a service (`Layer.succeed`); stores constructed through `Layer.effectContext` whose
  acquisition awaits each `ready` in sequence (DDL order preserved, `users` before `auth_sessions`).
- First scoped resource caveat (as shipped): the Turso client exposes only `execute`/`batch` — no `close` — so there is
  nothing to finalize yet. Scoped acquisition and the process `ManagedRuntime` therefore arrive with the first
  scope-owned resource (the HTTP server layer in phase 4); until then `createServices` materializes the bundle with a
  plain `Effect.runPromise`.
- `RunManager` construction becomes a `Runs` layer over `SessionStore` + provider factory. The provider factory stays
  promise-shaped until phase 2 converts the manager itself.
- `main.ts` is untouched (`createServices` retained as a thin promise facade for `mod.ts`/CLI compatibility);
  `startHttpServer` stays for now.
- Handlers keep their signatures — this phase proves the Layer pattern with zero behavior change.

Exit: tests pass; `pnpm relay` smoke works; no handler file changed.

### Phase 2 — RunManager → structured concurrency

Rewrite RunManager internals (API shape preserved where practical):

- One **fiber per run**; `cancel` = `Fiber.interrupt`. `run_finished` reason comes from the `Exit`
  (`completed`/`error`/`interrupted`) instead of manual abort bookkeeping.
- Per-session **`PubSub<ServerEvent>`**; `subscribe`/`getRunState` derive from it so late subscribers still get the
  `run_state` snapshot first. SSE handler only changes mechanically.
- Approvals as **`Deferred<ApprovalDecision>`**; interruption propagates automatically and a finalizer denies anything
  still pending. The handler passed to `withApproval` gains an Effect-returning variant that RunManager fulfills via
  `Deferred` (core tools stay Promise-based in this phase; the seam is adapted locally).
- Draft text / tool calls / tokens / cost move into `Ref`s; `releaseIfIdle` becomes refcounted or scope-based.

Exit: every phase-0 RunManager test passes; long-run stress (send, approve, cancel, reconnect SSE mid-run) behaves
identically; no `Promise` leak on cancel (approvals resolve).

### Phase 3 — Core runtime (provider, agent loop, tools)

- `LLMProvider.stream()` gains a `Stream`-typed variant (`Stream<Chunk, ProviderError>`); the fetch/SSE parsing stays,
  the async-iterable bridge goes.
- `agent.run()` becomes `Stream<AgentEvent, AgentError>` driven by an effectful loop (queue-backed stream). Retries use
  `Schedule.exponential` + a predicate replacing `isRetryableError`; `withStreamTimeout` becomes `Stream.timeout`;
  readonly tools run via `Effect.forEach(..., { concurrency: "unbounded" })`, side-effect tools sequentially.
- `Tool.execute` becomes `Effect<ToolResult, ToolError>`; `defineTool` updated; `withApproval` gates on
  `Effect<boolean>`.
- `runAgentLoop` survives as a compatibility adapter initially (callbacks), then RunManager consumes the `Stream`
  directly (small second touch from phase 2).
- Typed errors: `ProviderError`, `AgentError` variants; no more string-matching in retry logic.

Exit: scripted-provider tests reproduce the exact event sequence; `TestClock` proves backoff timing without real waits;
UI-visible behavior unchanged.

### Phase 4 — HTTP on `effect/http` + `@effect/platform-node`

- Serve via `NodeHttpServer.layerConfig` + `HttpServer.serve`; routes become an `HttpRouter` app. Middleware: CSRF
  origin check, per-request identity (`identity.ts`), API-key guard.
- SSE via `HttpServerResponse.stream` fed by RunManager's `Stream`; heartbeats reimplemented with a scheduled stream
  (behavior: comment frame every 15s, catch-up `run_state` first).
- Static serving via `HttpStaticServer.make({ root, index: true, spa: true })` — replaces `static.ts`, keeps path
  confinement; API 404s must stay JSON while non-API GETs fall back to `index.html` (test route precedence).
- Delete `http-server.ts` adapter. `startServer()` keeps its signature and still writes the state file; EADDRINUSE is
  detected from `ServeError.cause` and still exits 75. Preserve an internal `handleRequest`-shaped web-handler adapter
  (`HttpEffect.toWebHandler`) so phase-0 tests survive the migration.
- Structured teardown: server close and DB close become scope finalizers (graceful shutdown option on the layer).

Exit: endpoint parity table verified against phase-0 tests; dev proxy + prod static + OAuth redirect + SSE reconnect all
smoke-tested; `relay stop`/`status` unaffected.

**Decision gate**: client + CLI only proceed once phases 1–4 have soaked in real use.

### Phase 5 — Client Effect layer (dedupe web)

- Move `Api`, `SessionStream`, `RelayError` (currently in `packages/web/src/api/services.ts`) into
  `@vvtxn/client`, built on the existing Promise `RelayClient`. Web imports them from there and deletes its copy.
- `protocol.ts` and `RelayClient` remain plain/Promise — the transport must stay usable without an Effect runtime.
- `session-state.ts` reducer untouched.

Exit: web bundle unchanged in behavior; service layer importable from server-side CLI context.

### Phase 6 — CLI on Effect

- One `ManagedRuntime` for the CLI's async layer: REST calls, SSE consumption via fibers (interruption replaces manual
  abort handling), approval round-trips via `Deferred`.
- Supervisor (background server start/stop/status, state-file reads, port-conflict retry) as an Effect program with
  retries/timeouts.
- TUI rendering and signal store unchanged. **Non-goal**: adopting `effect/cli` — argument parsing stays as-is to keep
  UX and churn flat.
- Watch the bundled size (`vp pack`); verify tree-shaking and startup latency after adding Effect.

Exit: `pnpm relay` smoke matches current behavior; bundle size delta reviewed.

### Phase 7 — Cleanup & standardize

- Prune scaffolding per the testing policy (delete phases' `test/` folders unless individually justified).
- Update `AGENTS.md` in each package with the Effect boundary rules:
  - Effect is the runtime for asynchronous/concurrent/lifecycle code in server, core (node-side), client's Effect
    layer, and CLI's async layer.
  - Protocol types, the raw transport, `display.ts`/`theme.ts`/`fonts.ts`, and the CLI renderer stay Effect-free.
  - One `ManagedRuntime` per process; libraries expose Effects, hosts run them.
- Retire stale comments ("Effect-ready boundary", promise-based approval notes) and delete the migration branches'
  leftovers.

## Risks & mitigations

| Risk                                                   | Mitigation                                                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `effect/http` + platform are marked `@stability unstable` | Pin exact 4.0.4 versions; keep platform usage behind thin internal wrappers (`http/app.ts`) so API churn is localized      |
| Thin test suite (temporary by policy)                  | High-leverage tests only + manual smoke per phase; atomic phases; each phase is one revertable PR                          |
| Browser purity regression (Effect leaks into web)      | Keep the boundary rule in AGENTS.md; optionally add a check script that walks imports of the three browser-pure entrypoints |
| CLI bundle growth / startup latency                    | Measured in phase 6 before accepting; keep Effect out of the render path                                                   |
| EADDRINUSE/exit-75 semantics lost in platform move     | Explicit test in phase 4; CLI supervisor behavior documented as an exit criterion                                          |
| Scope creep (effect/ai, effect/cli, effect/rpc, …)     | Non-goals below; revisit only after phase 7                                                                                |

## Non-goals

- Replacing `CompletionsProvider` with `effect/ai` — the repo's provider is fine and protocol-facing.
- Replacing the SSE protocol with `effect/rpc` — wire protocol is frozen.
- Replacing the Turso client with `effect/sql` — can be revisited later as a separate effort.
- `effect/cli`, `effect/cluster`, `effect/workflow`.
- No behavior changes: this migration must be invisible to both clients (TUI and browser).

## Decisions log

1. **`SessionStore` becomes Effect-native all the way down** (decided): the DB leaf is wrapped once with
   `Effect.tryPromise` at the adapter, and every interface above it speaks `Effect`. No mixed Promise/Effect store
   contracts.
2. **CLI timing** (decided): phase 6 starts only after the client (phase 5) and the server have soaked in real use.
3. **Test retention** (open): default delete-at-phase-exit; revisit at phase 7 whether any RunManager lifecycle
   behaviors deserve permanent guards.

## Conventions for each phase

- Branch per phase: `refactor/effect-phase-N-<slug>`; small commits following Conventional Commits.
- Run `pnpm exec vp fmt` and `pnpm check` before each phase is considered done.
- One phase = one merge; no long-lived migration branch.
