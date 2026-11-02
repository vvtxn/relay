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
├── manager.ts        # lifecycle, leases, budgets, queue, idle sweeper
├── manifest.ts       # versioned box.json file store
├── workspace.ts      # reflink clone / linked-worktree clone + HTTPS remote rewrite
├── workspaces.ts     # per-session durable workspaces, markers, GC
├── sanitize.ts       # removes host credentials from the clone
├── config.ts         # .relay/box.json parsing + defaults merge
├── env.ts            # box command environment allowlist
└── microsandbox.ts   # the only native-SDK import (lazy dynamic import)
```

## Rules

- The server is the only writer. Box manifests are self-describing; do not add a second registry database.
- Manifests describe pooled project boxes: `workspacePath` is the project workspace root mounted at `/workspace`.
  Runs lease workers from the project pool; boxes are never session-affine.
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
- Never copy host credentials into a box as plaintext. Sanitization runs on every new session workspace clone;
  explicit env/secrets only. Local mode mirrors the host's `gh auth token` through the runtime secret mechanism, so the
  guest sees a placeholder substituted only for the allowed git host.
- The project directory and box data directory must not contain each other. Session workspace clones live under
  `RELAY_SESSION_WORKSPACE_ROOT`, which must not overlap the project directory either.
- Session workspaces are self-contained clones. SSH remotes are rewritten to HTTPS inside the clone so token-based
  askpass works; the original checkout and its remotes are never modified. The agent commits, pushes, and opens pull
  requests from the workspace instead of syncing patches back into the local checkout.
- The manifest stores a hash of the runtime secret set (never the values). When the configured credentials change, the
  next lease recreates the VM so it picks up the new token.
- `MicrosandboxRuntime` is lazy-loaded. A missing platform package or KVM must not prevent Relay from starting.
- Runtime methods are the remote seam: keep them serializable and free of host-path assumptions where possible.
- Box bash uses `sh -lc` (not every image has bash).
- Server runtime files use relative imports, not `#/` (native Node type stripping).

## Commands

```bash
pnpm exec vp fmt
pnpm check
pnpm box:image                 # build + load relay-box:local
```

`RELAY_BOX_IMAGE=auto` (the default) selects `relay-box:local` when it is loaded and falls back to `node:26-bookworm`.
The prepared image embeds Node 26, pnpm, Playwright + Chromium and its ffmpeg recorder, system ffmpeg, git, GitHub CLI,
ripgrep, and build/database tooling. When this image is active the runtime prompt requires real-browser verification of rendered UI changes; the
agent should use the `browser` tool / embedded browsers, never run `playwright install`, and never add probe `.mjs`
files to the repository. Verify box behavior end-to-end with
`pnpm relay:local` (boxes are on by default) when KVM is available. Stress the real runtime: create/exec, live
resize, pause/resume, stop, retention cleanup, and reconcile after a server restart. Set `RELAY_BOX=0` for the
unsandboxed host path (development only; the server logs a warning).
