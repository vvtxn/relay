import { defineConfig } from "vite";
import path from "node:path";

const here = import.meta.dirname ?? ".";

export default defineConfig({
	resolve: {
		alias: [
			{ find: "@vvtxn/relay/", replacement: path.resolve(here, "../relay/") },
			{ find: "@vvtxn/client/", replacement: path.resolve(here, "../client/") },
		],
	},
	esbuild: {
		jsx: "automatic",
		jsxImportSource: "preact",
	},
	server: {
		proxy: {
			"/api": {
				target: "http://127.0.0.1:7433",
			},
		},
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
});
