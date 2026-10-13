# Effect Migration Plan — server, core, client, CLI

Status: completed — phases 0–5 shipped as a stacked PR set (merge bottom-up); phase 6 deferred by choice (the CLI's
signal store needs its own design pass, which is not an Effect concern); phase 7 (cleanup) completes the migration.

Effect ran only in `packages/web` before this effort. The plan made it the standard runtime for async work, concurrency,
lifecycle, and error handling in `server`, `relay` core, and `client` — without touching the wire protocol or the
browser-pure modules that web imports.

The migration was deliberately sequenced so that every phase is independently shippable and revertable. Phases 5–6
(client, CLI) sat behind a decision gate; phase 5 landed, phase 6 was consciously postponed.

## Current state (pre-migration snapshot)

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

## Target architecture (as shipped)

- **One `ManagedRuntime` per long-lived process.** Web already has one. Server gets one; CLI gets one in phase 6.
  `relay` core and `client` are libraries: they *expose* Effects/Streams/Layers but never own or run a runtime.
- **Server**: Layers for all composition; HTTP served by `effect/http` (`HttpRouter`, `HttpServer`,
  `HttpServerResponse.stream`) with `NodeHttpServer` from `@effect/platform-node` (v4 does not have a standalone
  `@effect/platform` for the server: HTTP lives in `effect/http`, Node bindings in `@effect/platform-node`).
- **Core**: provider `stream()` returns `Stream<StreamChunk, ProviderError>`; `agent.run()` returns
  `Stream<AgentEvent>` with failures surfacing in-band as `error` events (the UI-visible contract); tools execute as
  `Effect<ToolResult, ToolError>`; retries via `Schedule.exponential`; timeouts via `Stream.timeoutOrElse`.
- **Client**: `protocol.ts` and the raw `RelayClient` Promise API stay plain. The Effect `Api`/`SessionStream` service
  layer that currently lives in web **moves into `@vvtxn/client`**, so web stops duplicating it and the CLI inherits it.
  `session-state.ts` stays a pure reducer.
- **CLI**: effect-backed runtime for its async/data layer (requests, SSE consumption, approvals, supervisor
  start/stop); TUI signals and renderer untouched.
- **Error handling**: tagged errors at every boundary (`Data.TaggedError`), mapped once per interface — router →
  HTTP status, runner → `run_finished` reason, CLI → inline error.

## Testing strategy

The migration produced a small, behavior-first suite that is now **permanent coverage** (the retention review is
recorded in the decisions log). The policy going forward:

- **Behavior over structure**: black-box HTTP tests via the `handleRequest` adapter, layer-level tests for
  `RunManager`/agent semantics, and pin tests for the shared client service layer. No snapshot tests, no tests that
  restate implementation details or pure helpers — that was the noise that was removed in this repo's history.
- **Fakes over mocks**: scripted `Stream` providers, in-memory session stores, `TestClock` so backoff and the stream
  timeout are proven on virtual time.
- **Small surface**: 32 tests across five files under `packages/*/test/`, covering run conflict/cancel, approvals
  (allow/always/deny/deny-on-cancel), run snapshots and late subscribers, retry classification, stream timeout, loop
  detection, store DDL order, the auth gate, CSRF, SPA precedence, SSE streaming, and client error mapping.
- **CI**: `.github/workflows/ci.yml` runs `pnpm check`, `pnpm exec vp test`, and `pnpm build`.
- **Manual smoke** after risky changes: `pnpm relay` (TUI send/approve/cancel), `pnpm relay web`, and
  `pnpm relay stop/status`.

## Phases at a glance

| # | Phase                              | Package(s)     | Big-ticket moves                                                  | Exit criteria                                             |
| - | ---------------------------------- | -------------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| 0 | Baseline & scaffolding             | tooling        | version alignment, vitest wiring, characterization tests          | tests green on current code                               |
| 1 | Composition → Layers               | server         | DB/stores/RunManager as Layers, process `ManagedRuntime`          | identical behavior, services built by layers              |
| 2 | RunManager → structured concurrency | server (+core) | fiber per run, subscriber queues, `Deferred`, `Ref`, interrupt-fold | all RunManager semantics preserved, approvals auto-deny   |
| 3 | Core runtime                       | relay          | provider/agent → `Stream`, tools → `Effect`, `Schedule` retries   | same `AgentEvent` sequence, typed errors, TestClock green |
| 3.5 | Effect-native store interfaces   | relay + server | `SessionStore`/auth stores speak `Effect`, promise bridges deleted | no promise facades in server paths                        |
| 4 | HTTP → effect/http + platform-node | server         | `HttpRouter`, SSE as stream, `HttpStaticServer` (spa), state file | route/status parity, exit 75 preserved, adapter deleted   |
| 5 | Client Effect layer                | client + web   | move web's `Api`/`SessionStream` into client, dedupe web          | web unchanged visually, CLI can adopt services            |
| 6 | CLI runtime (deferred)             | cli            | `ManagedRuntime` for data layer, fibers for SSE/approvals         | TUI behavior unchanged, bundle builds                     |
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

RunManager internals rewritten (public API and SSE handler unchanged):

- One **fiber per run**; `cancel` = `Fiber.interrupt`. The `run_finished` reason is derived from the run effect's `Exit`
  (success value, or interruption) instead of manual abort bookkeeping. A single uninterruptible finalizer aborts the
  provider call, denies pending approvals, flushes the handle, announces `run_finished`, and releases the session.
- Fan-out **as shipped**: per-subscriber `Queue`s registered synchronously (`Queue.unbounded` + `Queue.offerUnsafe`),
  not `PubSub` — v4's `PubSub.subscribe` is scoped and therefore asynchronous, which would open a drop window between
  the SSE handler's `run_state` snapshot and its subscription. Queues preserve the deterministic
  snapshot-then-listen contract with no SSE changes; phase 4 may revisit `PubSub` inside an Effect-native SSE handler.
- Approvals as **`Deferred<ApprovalDecision>`**; `resolveApproval` takes the Deferred out of the run `Ref` atomically.
  The finalizer denies whatever is still pending, so promises cannot leak. Core tools stay Promise-based this phase:
  the `withApproval` handler bridges via `Deferred.await` → Promise.
- Draft text / tool calls / pending approvals live in a per-run `Ref<RunState>`; tokens / cost / "always" approvals are
  session-scoped fields on the session record (they persist across runs until the session is released).
- `providerFor` stays promise-shaped until phase 3 converts the agent loop.

Exit (met): every phase-0 RunManager test passes, plus new guards for mid-run `run_state` snapshots, late subscribers,
sequential runs on one session, and immediate cancel; `pnpm check` clean; real server boot smoke green.

### Phase 3 — Core runtime (provider, agent loop, tools) — as shipped

- `LLMProvider.stream()` now returns `Stream<StreamChunk, ProviderError>`; fetch/SSE parsing stays promise-based behind a
  single `Stream.fromAsyncIterable` bridge. Failures are classified where they occur: `ProviderError.retryable` comes
  from the HTTP status (429/5xx), timeouts/transport (retryable), and aborts / unreadable bodies (not retryable). No
  error-message pattern matching anywhere.
- `agent.run()` returns `Stream<AgentEvent>` (error channel `never`). The loop keeps its imperative shape via
  `Stream.callback`, but all waiting is Effectful: retries are `Effect.retry` with `Schedule.exponential(1s)`,
  `while: (error) => error.retryable`, `times: 2`; the 60s stream timeout is `Stream.timeoutOrElse` failing with a
  retryable `ProviderError`; readonly tools run through `Effect.forEach(..., { concurrency: "unbounded" })`, side-effect
  tools sequentially. Provider failures still surface as in-band `error` events (UI-visible contract), so an
  `AgentError` channel is deliberately absent.
- **As shipped, `tool_call_end` carries `name` and `args`** (the accumulator values the old runner callbacks had to
  rebuild for every consumer).
- `Tool.execute` returns `Effect<ToolResult, ToolError>` (typed `ToolError`); `defineTool` still authors tool bodies as
  async functions and lifts them. `withApproval` takes an `Effect<boolean>` handler.
- `RunManager` consumes `run()` directly: the callbacks bridge is gone, and the approval wait is now `Deferred.await`
  inside the run fiber, so interruption cancels it with no promise to leak.
- `runAgentLoop` survives as a public compatibility adapter implemented over the stream; it has no internal consumers.
- Testing note: `@effect/vitest` cannot run under `vp test` (the bundled Vitest is a different module instance than an
  installed `vitest` peer), so agent tests import `vite-plus/test` and provide a `TestClock.layer()` themselves. A small
  `joinDrivingClock` helper polls the fiber while stepping the clock, because `TestClock.adjust` only releases sleepers
  that are already registered.

Exit (met): the scripted-provider tests reproduce the prior event sequences; retry/backoff and the timeout budget are
proven on `TestClock` without real waits; `pnpm check` clean; web build and real server boot smoke green.

### Phase 3.5 — Effect-native store interfaces — as shipped

- `SessionHandle` / `SessionStore` (`sessions/types.ts`, `db.ts`, `file.ts`, `manager.ts`) and the auth stores
  (`DatabaseUserStore`, `DatabaseUserSettingsStore`, `DatabaseAuthSessionStore`, plus the `UserStore` /
  `UserDirectory` / `AuthSessionStore` interfaces and `authenticate()`) now expose `Effect` operations.
- A tagged `StoreError` and a `storeEffect()` helper (in `core/effect.ts`) wrap the promise-based adapter bodies at
  the public boundary; internal mechanics that are meaningful as promises (the handle append queue, the schema-ready
  latch) stay promise-based behind it. Synchronous in-memory reads (`getEntries`, `getHeader`, tokens/cost) stay sync.
- `ready` becomes `Effect<void, StoreError>` on every store; the services layer consumes it with a plain `yield*`.
- `RunManager` consumes the stores directly: `providerFor` is Effect-returning and the handle's `append`/`flush` are
  piped into the run fiber; its unused `sessionStore` option was removed.
- Session / auth / settings / workspace handlers still materialize store effects with one `Effect.runPromise` per call
  — a transitional bridge that phase 4 deletes when the handlers become Effects.
- Deliberately untouched: `auth/session-file.ts` (the CLI's sync token handoff file, not a store contract).

Exit (met): no store call in `packages/server` goes through a promise facade (handlers bridge instead); the
characterization suite is unchanged and green; `pnpm check`, build, and real boot + auth-path smokes pass.

### Phase 4 — HTTP on `effect/http` + `@effect/platform-node` — as shipped

- Production serving: `NodeHttpServer.layer` + `HttpRouter.serve(app)`, launched with `Layer.launch`; a `Layer.tap`
  runs after the listener is bound and writes the CLI state file, so `relay stop`/`status` are unaffected.
  EADDRINUSE stays exit code 75 (the `ServeError` cause chain is walked) — verified against a live second bind.
- Routing: an `HttpRouter` app with per-route guards instead of the central dispatcher — `withCsrf` (origin check) and
  `authenticated` (identity resolution → 401) wrap each handler; one `respond()` error mapper turns the tagged errors
  into 400/401/403/404/413 and everything else into a 500. The session pattern regex reproduces the old 404-vs-405
  semantics for `/api/sessions/*`.
- Handlers are Effects end to end (sessions, approvals, files, workspace, settings, auth, SSE); the `runPromise`
  bridges from phase 3.5 are gone. Body parsing reimplements the 1 MiB cap over `request.stream`; request cookies come
  from `HttpServerRequest.cookies` (the old `parseCookies` was deleted).
- SSE is `HttpServerResponse.stream`: connected comment + `run_state` snapshot preamble, then
  `RunManager.subscribeStream` merged with a `Stream.tick` heartbeat.
- Static serving is `HttpStaticServer` (`spa: true`, `index.html`) mounted as the catch-all for non-API GETs, replacing
  `static.ts`. Refinements vs the old blanket fallback: SPA fallback requires an extension-less path with
  `Accept: text/html`, and stale asset URLs now 404 instead of returning the shell. `RouteNotFound` maps to the JSON
  404 the API expects.
- `handleRequest(services, request)` survives as an in-process adapter (`HttpRouter.toWebHandler`, cached per services
  instance) so the characterization suite kept its shape. `http-server.ts` and `static.ts` are deleted.

Exit (met): endpoint parity through the phase-0 router tests plus new SSE-streaming and SPA-precedence coverage (28
tests total); `pnpm check` clean; build green; live smokes cover health, identity 401 against the real database, SPA
serving, JSON API 404s, the state file, and the exit-75 bind conflict.

**Decision gate**: client + CLI only proceed once phases 1–4 have soaked in real use.

### Phase 5 — Client Effect layer (dedupe web) — as shipped

- `@vvtxn/client/services.ts` now owns `RelayError`, `isUnauthorized`, the `Api` service (`ApiLive(client)`), the
  `SessionStream` service, and the `appLayer(client)` combinator. Web's `api/services.ts` is deleted;
  `api/runtime.ts` installs `appLayer(client)` from the browser-configured client.
- The transport (`client.ts`), protocol, SSE parser, and reducer stay Promise/pure; `effect` joins the client package
  only for this module, so the CLI can adopt the layer incrementally (phase 6).
- Exports join `mod.ts` for discoverability. Web already bundles `effect` (nothing changes there); the CLI bundle
  externalizes workspace dependencies, so it stays untouched until phase 6.
- Pin tests in `packages/client/test/services.test.ts` cover success passthrough, `RelayApiError` → `RelayError`
  status mapping, transport failures without a status, and SSE streaming through `SessionStream`.

Exit (met): web type-checks and builds with behavior unchanged (same client, same layer semantics); the shared layer is
exercised under Node in the suite.

### Phase 6 — CLI on Effect (deferred by choice)

> **Deferred:** the CLI's state is signal-based and predates this migration; reworking it is its own design effort, not
> an Effect one. The shared `@vvtxn/client/services.ts` layer is ready for adoption whenever that work happens. The
> bullets below are the intake sketch, kept for reference.

- One `ManagedRuntime` for the CLI's async layer: REST calls, SSE consumption via fibers (interruption replaces manual
  abort handling), approval round-trips via `Deferred`.
- Supervisor (background server start/stop/status, state-file reads, port-conflict retry) as an Effect program with
  retries/timeouts.
- TUI rendering and signal store unchanged. **Non-goal**: adopting `effect/cli` — argument parsing stays as-is to keep
  UX and churn flat.
- Watch the bundled size (`vp pack`); verify tree-shaking and startup latency after adding Effect.

### Phase 7 — Cleanup & standardize — as shipped

- Pruned the scaffolding framing: the behavioral core of the suite survives as permanent coverage (decision log item
  3). TEMP markers and delete-at-phase-exit wording are gone, CI naming is neutral, and a review of all 32 tests found
  none that qualify as noise — each pins a behavioral seam.
- AGENTS.md boundary rules landed in the root file (**Effect Runtime Boundaries**) and per package: server
  (effect/http + fibers concepts), relay core and api (stream-based loop, Effect tool/store contracts, `ProviderError`
  classification), client (service layer + tests), web (shared-layer references).
- Retired stale comments: "phase N" markers in `services.ts`/`run.ts`, references to the deleted node:http adapter and
  `static.ts`, and the old "Effect-ready boundary" phrasing.

## Risks & mitigations

| Risk                                                   | Mitigation                                                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `effect/http` + platform are marked `@stability unstable` | Pin exact 4.0.4 versions; keep platform usage behind thin internal wrappers (`http/app.ts`) so API churn is localized      |
| Thin test suite (by design)                            | Behavior-first tests at the seams + CI + manual smoke; atomic phases; each phase is one revertable PR                     |
| Browser purity regression (Effect leaks into web)      | Keep the boundary rule in AGENTS.md; optionally add a check script that walks imports of the three browser-pure entrypoints |
| CLI bundle growth / startup latency                    | Measured when phase 6 is taken up; keep Effect out of the render path                                                      |
| EADDRINUSE/exit-75 semantics lost in platform move     | Explicit test in phase 4; CLI supervisor behavior documented as an exit criterion                                          |
| Scope creep (effect/ai, effect/cli, effect/rpc, …)     | Non-goals below; revisit only after phase 7                                                                                |

## Non-goals

- Replacing `CompletionsProvider` with `effect/ai` — the repo's provider is fine and protocol-facing.
- Replacing the SSE protocol with `effect/rpc` — wire protocol is frozen.
- Replacing the Turso client with `effect/sql` — can be revisited later as a separate effort.
- `effect/cli`, `effect/cluster`, `effect/workflow`.
- No behavior changes: this migration must be invisible to both clients (TUI and browser).

## Decisions log

1. **`SessionStore` becomes Effect-native all the way down** (decided; shipped in phase 3.5): the DB leaf is wrapped
   once with `Effect.tryPromise` at the adapter, and every interface above it speaks `Effect`. No mixed Promise/Effect
   store contracts.
2. **CLI timing** (decided, revised): phase 6 is deferred beyond this migration. The CLI's TUI state is signal-based;
   reworking that store is a separate design effort, not an Effect concern. The shared client service layer is ready
   when it happens.
3. **Test retention** (decided at phase 7): the behavioral core stays as permanent coverage — all 32 tests across the
   five suites, reviewed individually; none restate implementation details. Scaffolding framing and TEMP markers are
   removed. New tests follow the same behavior-first, no-noise bar.

## Conventions for each phase

- Branch per phase: `refactor/effect-phase-N-<slug>`; small commits following Conventional Commits.
- Run `pnpm exec vp fmt` and `pnpm check` before each phase is considered done.
- One phase = one merge; no long-lived migration branch.

## Branch stack & merge order

The migration landed as stacked PRs. Each targets the previous phase; GitHub retargets the children to `main` as each
merge lands. Merge bottom-up:

| Phase   | Branch                                | PR   |
| ------- | ------------------------------------- | ---- |
| 0       | `refactor/effect-phase-0-baseline`    | #71  |
| 1       | `refactor/effect-phase-1-layers`      | #72  |
| 2       | `refactor/effect-phase-2-runmanager`  | #73  |
| 3       | `refactor/effect-phase-3-core-runtime`| #74  |
| 3.5     | `refactor/effect-phase-3.5-stores`    | #75  |
| 4       | `refactor/effect-phase-4-http`        | #76  |
| 5       | `refactor/effect-phase-5-client-layer`| #77  |

Validation per merge: `pnpm install && pnpm check && pnpm exec vp test`, plus the phase's manual smoke (each PR lists
one). CI runs for a PR once it targets `main`, so each stacked PR gets the full check/test/build job as it retargets
bottom-up; before that, validate a tip locally with the commands above. Phases 6 (CLI runtime) and 7 (cleanup/prune
the temporary suites) follow after this stack soaks.
