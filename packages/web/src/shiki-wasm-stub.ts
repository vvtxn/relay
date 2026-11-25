/**
 * Stub for `shiki/wasm`, aliased in `vite.config.ts`.
 *
 * `@pierre/diffs` only imports the WASM engine payload inside its
 * `preferredHighlighter: "shiki-wasm"` branch, which the app never takes (see
 * `highlight.ts`). Without this alias, the bundler still emits the ~600 KB
 * WASM chunk even though it is unreachable at runtime.
 */
export default undefined;
