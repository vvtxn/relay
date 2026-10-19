# AGENTS.md - Box

Optional per-session Microsandbox microVMs. One box per session, created lazily on the first run.

## Layout

```
box/
├── types.ts          # BoxSpec, BoxManager, BoxRuntime, ExecResult
├── errors.ts         # BoxError
├── service.ts        # Effect Context.Service + Layer
├── manager.ts        # lifecycle, leases, LRU scheduler, idle sweeper
├── manifest.ts       # box.json file store
├── workspace.ts      # reflink clone / linked-worktree clone
├── sanitize.ts       # removes host credentials from the clone
├── config.ts         # .relay/box.json parsing + defaults merge
├── env.ts            # box command environment allowlist
├── microsandbox.ts   # the only native-SDK import (lazy dynamic import)
└── test/
```

## Rules

- The server is the only writer. Box manifests are self-describing; do not add a second registry database.
- One box per session. The session header keeps the project cwd; the box workspace is an internal path.
- A lease pins a running box and protects it from idle eviction. Release it in a run finalizer.
- Stopped is the default idle state. Do not pause/resident-suspend boxes in v0.
- Never copy host credentials into a box. Sanitization runs on every new workspace clone; explicit env only.
- `MicrosandboxRuntime` is lazy-loaded. A missing platform package or KVM must not prevent Relay from starting.
- Runtime methods are the remote seam: keep them serializable and free of host-path assumptions where possible.
- Box bash uses `sh -lc` (not every image has bash). Project hooks may invoke `bash -lc` explicitly.
- Server runtime files use relative imports, not `#/` (native Node type stripping).

## Commands

```bash
pnpm exec vp fmt
pnpm check
pnpm exec vp test
RELAY_BOX_TEST=1 pnpm exec vp test packages/box/test/microsandbox.integration.test.ts
```

The integration test needs KVM and pulls `alpine` (or `RELAY_BOX_TEST_IMAGE`). It is skipped by default.
