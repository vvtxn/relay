# AGENTS.md - Box

Managed Microsandbox microVMs. Boxes are first-class objects; sessions attach to them. A session may auto-create a
box on its first run, but box identity, paths, runtime names, and scheduling keys never contain session ids.

## Layout

```
box/
├── types.ts          # BoxSpec, BoxManager, BoxRuntime, profiles, status
├── errors.ts         # BoxError
├── service.ts        # Effect Context.Service + Layer
├── profiles.ts       # tiny/small/medium resource bundles
├── manager.ts        # lifecycle, attachments, leases, budgets, queue, idle sweeper
├── manifest.ts       # versioned box.json file store + v1 migration
├── workspace.ts      # reflink clone / linked-worktree clone
├── sanitize.ts       # removes host credentials from the clone
├── config.ts         # .relay/box.json parsing + defaults merge
├── env.ts            # box command environment allowlist
└── microsandbox.ts   # the only native-SDK import (lazy dynamic import)
```

## Rules

- The server is the only writer. Box manifests are self-describing; do not add a second registry database.
- Boxes are independent. `attachments[]` is metadata; `originSessionId` is provenance only.
- Multiple sessions may attach, but execution is exclusive by default: one active lease per box.
- A lease pins a running box and protects it from idle eviction. Release it in a run finalizer.
- Resident VMs (starting, ready, busy, paused) consume the memory/CPU budget. Stopped boxes cost disk only.
- Idle transitions are tiered: ready → paused (services stay alive) → stopped. Pause failure falls back to stop.
- `resize()` is live within the boot-time `maxCpus`/`maxMemory` ceilings; disk is grow-only.
- Capacity is reserved atomically before runtime calls. Failed starts/resizes must release the reservation.
- Never copy host credentials into a box. Sanitization runs on every new workspace clone; explicit env/secrets only.
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
agent should use the embedded browsers and never run `playwright install`. Verify box behavior end-to-end with
`pnpm relay:local` (boxes are on by default) when KVM is available. Stress the real runtime: create/exec, live
resize, pause/resume, stop, retention cleanup, and reconcile after a server restart. Set `RELAY_BOX=0` for the
host/approval path.
