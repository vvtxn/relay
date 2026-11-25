import { defineConfig } from "vite-plus";
import solid from "vite-plugin-solid";
import path from "node:path";

const here = import.meta.dirname ?? ".";

export default defineConfig({
	plugins: [solid()],
	resolve: {
		// `#/` resolves through the package.json `imports` field.
		alias: [
			// Keep Shiki's full registries (every grammar, every theme, the WASM
			// engine) out of the bundle; see `src/shiki-shim.ts`. Subpath imports
			// (`shiki/core`, `shiki/engine/*`) still resolve to the real package.
			{ find: /^shiki$/, replacement: path.resolve(here, "src/shiki-shim.ts") },
			// The WASM payload is only reachable from the unused `shiki-wasm`
			// highlighter branch; stub it so no ~600 KB chunk is emitted.
			{ find: /^shiki\/wasm$/, replacement: path.resolve(here, "src/shiki-wasm-stub.ts") },
			// Render only the two Pierre themes in use; see
			// `src/pierre-themes-shim.ts`.
			{ find: /^@pierre\/theming\/themes$/, replacement: path.resolve(here, "src/pierre-themes-shim.ts") },
			{ find: /^@vvtxn\/relay\//, replacement: path.resolve(here, "../relay") + "/" },
			{ find: /^@vvtxn\/client\//, replacement: path.resolve(here, "../client") + "/" },
		],
	},
	build: {
		target: "esnext",
		outDir: "dist",
		emptyOutDir: true,
	},
});
