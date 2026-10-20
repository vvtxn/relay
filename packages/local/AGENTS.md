# AGENTS.md - Local Executable

Builds the Linux x64 single executable (`dist/relay`). The package is packaging-only: it does not reimplement the
server, CLI, or database.

## Layout

```
local/
├── main.ts         # SEA entry: extract assets, apply local defaults, import the CLI
├── vite.config.ts  # bundles the CLI/server/TUI and asks Vite+ Pack for a SEA
└── .sea-assets.json # generated build manifest (gitignored)
```

## How it works

- `scripts/build-sea.ts` builds the web app, copies the libSQL runtime tree into a temporary directory, writes an asset
  manifest, and runs `vp -C packages/local pack`. Vite+ Pack's `exe` mode bundles everything into one SEA.
- Assets are keyed `web/…`, `fonts/…`, and `runtime/…`. On first launch `main.ts` extracts them under
  `~/.relay/runtime/<version>/`.
- The libSQL native addon cannot be loaded from SEA assets. `runtime/` contains the JS packages plus
  `@libsql/linux-x64-gnu`; `RELAY_DB_MODULE` points `createRequire` at the extracted runtime.
- `RELAY_STATIC_DIR` points at the extracted web build; `RELAY_FONT_DIR` points at the extracted fonts.
- The binary re-executes itself with `serve` for the background server, so source entry paths are never used in SEA.

## Rules

- Keep the package packaging-only. Server/auth/database behavior belongs in `packages/server`, `packages/relay`, etc.
- Never statically import `@libsql/client` here; it has a native addon and is loaded from the extracted runtime.
- Keep new runtime dependencies in the asset tree (the build script copies the dependency closure).
- The target is Linux x64 only for now. macOS/Windows would need their own native platform package and SEA job.
- Run `pnpm build:sea` and `pnpm smoke:sea` after changes.

## Commands

```bash
pnpm build:sea
pnpm smoke:sea
```
