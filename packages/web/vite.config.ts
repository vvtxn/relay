import { defineConfig } from "vite-plus";
import solid from "vite-plugin-solid";
import path from "node:path";
import { readFileSync } from "node:fs";
import { serverStatePath } from "../relay/core/server-state.ts";

const here = import.meta.dirname ?? ".";
const DEFAULT_API_PORT = 7433;

/**
 * The API origin the dev proxy forwards to.
 *
 * The background server records its actual URL in the mode-specific state file
 * (`~/.relay/server-local.json` or `server-cloud.json`; the CLI may start it on
 * a fallback port when the default is taken), so read that first and only fall
 * back to the default. `web:dev` defaults to local; set `RELAY_FLAVOR=cloud` to
 * follow a cloud server.
 */
function relayApiTarget(): string {
	const flavor = process.env.RELAY_FLAVOR ?? "local";
	// Prefer the selected mode's state, then the legacy unflavored state.
	for (const path of new Set([serverStatePath(flavor), serverStatePath(null)])) {
		try {
			const state = JSON.parse(readFileSync(path, "utf8")) as { url?: unknown };
			if (typeof state.url === "string" && state.url.length > 0) return state.url;
		} catch {
			// Try the next candidate.
		}
	}
	const port = process.env.RELAY_PORT ?? String(DEFAULT_API_PORT);
	return `http://127.0.0.1:${port}`;
}

export default defineConfig({
	plugins: [solid()],
	resolve: {
		// `#/` resolves through the package.json `imports` field.
		alias: [
			{ find: /^@vvtxn\/relay\//, replacement: path.resolve(here, "../relay") + "/" },
			{ find: /^@vvtxn\/client\//, replacement: path.resolve(here, "../client") + "/" },
		],
	},
	server: {
		fs: {
			allow: [path.resolve(here, "..")],
		},
		proxy: {
			"/api": {
				target: relayApiTarget(),
			},
		},
	},
	build: {
		target: "esnext",
		outDir: "dist",
		emptyOutDir: true,
	},
});
