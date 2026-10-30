# AGENTS.md - Box

Managed Microsandbox microVMs. Boxes are pooled compute workers per owner + project. Sessions own durable
workspaces; runs lease a box only while a sandbox tool executes. Box identity, paths, runtime names, and scheduling
keys never contain session ids.

## Layout

```
box/
├── types.ts          # BoxSpec, BoxManager, BoxRuntime, profiles, status
├── errors.ts         # BoxError
├── service.ts        # Effect Context.Service + Layer
├── profiles.ts       # tiny/small/medium resource bundles
├── manager.ts        # lifecycle, attachments, leases, budgets, queue, idle sweeper
├── manifest.ts       # versioned box.json file store + v1 migration
├── workspace.ts      # reflink clone / linked-worktree clone + sync baseline
├── workspaces.ts     # per-session durable workspaces, markers, GC
├── sync.ts           # git baseline + checkout/thread-branch sync
├── sanitize.ts       # removes host credentials from the clone
├── config.ts         # .relay/box.json parsing + defaults merge
├── env.ts            # box command environment allowlist
└── microsandbox.ts   # the only native-SDK import (lazy dynamic import)
```

## Rules

- The server is the only writer. Box manifests are self-describing; do not add a second registry database.
- v3 manifests describe pooled project boxes: `workspacePath` is the project workspace root mounted at `/workspace`.
  v2 manifests are legacy, own a session workspace clone, and remain session-affine until retired. Pooled boxes
  reject session attach/detach; runs lease them from the project pool.
- Sessions own workspaces under `RELAY_SESSION_WORKSPACE_ROOT`; a box never owns project files. The run path passes
  the session workspace host path and in-box exec path to `BoxSpec`/`BoxLease`.
- Multiple runs may use a project's pool sequentially, but execution is exclusive: one active lease per box.
- A lease pins a running box and protects it from idle eviction. A run pins its first sandbox lease until the run
  finalizer, so bash, browser checks, and services stay on one VM; a run that never uses a sandbox tool never leases.
- Resident VMs (starting, ready, busy, paused) consume the memory/CPU budget. Stopped boxes cost disk only.
- Idle transitions are tiered: ready → paused (services stay alive) → stopped. Pause failure falls back to stop.
  Microsandbox refuses a graceful stop while paused, so `runtime.stop()` resumes the VM first (or bounded-kills it).
- `resize()` is live within the boot-time `maxCpus`/`maxMemory` ceilings; disk is grow-only.
- Capacity is reserved atomically before runtime calls. Failed starts/resizes must release the reservation. Queued
  requests report their position through `BoxSpec.onQueued`.
- Never copy host credentials into a box. Sanitization runs on every new session workspace clone; explicit env/secrets
  only.
- Pooled v3 boxes ignore `setup`/`resume` hooks: those hooks assume one project checkout at `/workspace`, while a v3
  box mounts a project workspace root. Treat project setup as session-workspace work (or use a legacy box) until a
  workspace-scoped setup hook lands.
- Each Git-cloned session workspace gets a hidden `refs/relay/baseline` commit of its post-sanitize state. Sync diffs
  against that ref, so pre-existing checkout dirt is never replayed. Never delete/rewrite the baseline except when
  advancing it after a successful sync.
- The default v3 sync commits the session patch to `relay/thread/<sessionId>` in the project repository using a
  three-way apply onto the branch tip (or project HEAD for a new branch). The checkout is never modified, so threads
  do not clobber each other; review with `git diff <base>...<branch>` and merge when ready. `RELAY_THREAD_BRANCHES=0`
  restores checkout sync. Legacy boxes always use checkout sync. Thread branches are retained when a session is
  pruned so review work is never silently deleted.
- Checkout sync applies a patch to the project checkout working tree (not the index) and fails on a
  diverged/conflicting checkout instead of overwriting it. Both modes serialize per project. A successful sync
  advances the baseline. Legacy boxes backfill a baseline on their next acquisition; changes made before that point
  cannot be recovered automatically.
- `syncWorkspace` must use `--no-ext-diff`: a user-level `diff.external` (e.g. difftastic) would otherwise turn the
  patch into a human-readable diff and break `git apply`.
- `MicrosandboxRuntime` is lazy-loaded. A missing platform package or KVM must not prevent Relay from starting.
- Runtime methods are the remote seam: keep them serializable and free of host-path assumptions where possible.
- Box bash uses `sh -lc` (not every image has bash). Project hooks may invoke `bash -lc` explicitly.
- Server runtime files use relative imports, not `#/` (native Node type stripping).

## Commands

```bash
pnpm exec vp fmt
pnpm check
pnpm box:image                 # build + load relay-box:local
```

`RELAY_BOX_IMAGE=auto` (the default) selects `relay-box:local` when it is loaded and falls back to `node:26-bookworm`.
The prepared image embeds Node 26, pnpm, Playwright + Chromium at `/opt/playwright`, git, ripgrep, and build/database
tooling. When this image is active the runtime prompt requires real-browser verification of rendered UI changes; the
agent should use the `browser` tool / embedded browsers, never run `playwright install`, and never add probe `.mjs`
files to the repository. Verify box behavior end-to-end with
`pnpm relay:local` (boxes are on by default) when KVM is available. Stress the real runtime: create/exec, live
resize, pause/resume, stop, retention cleanup, and reconcile after a server restart. Set `RELAY_BOX=0` for the
unsandboxed host path (development only; the server logs a warning).
