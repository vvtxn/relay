import { defineConfig } from "vite-plus";

/**
 * The CLI is the only package that needs bundling: Node cannot run TSX, and
 * the TUI is built on custom JSX. Everything else (relay core, client, server)
 * runs as native TypeScript under Node, so workspace dependencies are
 * externalized and resolved from `node_modules` at runtime.
 */
export default defineConfig({
	pack: {
		entry: ["agent/index.ts"],
		format: ["esm"],
		platform: "node",
		dts: false,
		sourcemap: true,
		clean: true,
		deps: {
			// Workspace packages run as native TypeScript from node_modules.
			neverBundle: [/^@vvtxn\//],
		},
		inputOptions: {
			transform: {
				// `jsxImportSource` comes from tsconfig.json ("#/tui/render").
				jsx: { runtime: "automatic" },
			},
		},
	},
});
