import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { getAsset, getAssetKeys, isSea } from "node:sea";
import { parseEnv } from "node:util";
import { relayDir } from "@vvtxn/relay/core/paths.ts";
import { VERSION } from "@vvtxn/relay/version.ts";

/**
 * Single-executable entry point.
 *
 * The SEA contains the CLI/server bundle plus `web/`, `fonts/`, and the
 * `runtime/` libSQL dependency tree. On first launch it extracts those assets
 * to a versioned directory under `~/.relay`, then points the normal server at
 * them. In a source checkout this is a no-op and the CLI runs from its usual
 * paths.
 */

function runtimeRoot(): string {
	return join(relayDir(), "runtime", VERSION);
}

function writeAsset(key: string, root: string): void {
	const relative = key.startsWith("runtime/") ? key.slice("runtime/".length) : key;
	const target = resolve(root, relative);
	if (target !== root && !target.startsWith(root + sep)) {
		throw new Error(`Refusing to extract asset outside the runtime directory: ${key}`);
	}
	mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
	writeFileSync(target, Buffer.from(getAsset(key)), { mode: 0o600 });
}

function ensureRuntime(): void {
	if (!isSea()) return;

	const root = runtimeRoot();
	const marker = join(root, ".complete");
	// Re-extract when the executable itself is newer than the marker. This
	// keeps local rebuilds (same version) from reusing stale assets.
	let needsExtraction = !existsSync(marker);
	if (!needsExtraction) {
		try {
			needsExtraction = statSync(marker).mtimeMs < statSync(process.execPath).mtimeMs;
		} catch {
			needsExtraction = true;
		}
	}

	if (needsExtraction) {
		const keys = getAssetKeys();
		if (keys.length === 0) throw new Error("The Relay executable has no embedded runtime assets");

		rmSync(root, { recursive: true, force: true });
		mkdirSync(root, { recursive: true, mode: 0o700 });
		for (const key of keys) {
			if (key.startsWith("web/") || key.startsWith("fonts/") || key.startsWith("runtime/")) {
				writeAsset(key, root);
			}
		}
		// `createRequire` in the database layer resolves @libsql/client from
		// this file's directory.
		writeFileSync(join(root, "index.cjs"), "", { mode: 0o600 });
		writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
	}

	// The embedded assets are authoritative in a SEA. A project or repo `.env`
	// may still point at source paths from development; never use those.
	process.env.RELAY_STATIC_DIR = join(root, "web");
	process.env.RELAY_FONT_DIR = join(root, "fonts");
	process.env.RELAY_DB_MODULE = join(root, "index.cjs");
}

function loadEnvFiles(): void {
	if (!isSea()) return;
	const files = [".env"];
	// Most specific first: project cwd, then the home data dir. Values are only
	// filled when absent, so process env > cwd .env > home .env.
	const roots = [process.cwd(), relayDir()];
	for (const file of files) {
		for (const root of roots) {
			try {
				const values = parseEnv(readFileSync(join(root, file), "utf8"));
				for (const [key, value] of Object.entries(values)) {
					// Empty values count as unset, matching server config parsing.
					if (value && (process.env[key] === undefined || process.env[key] === "")) process.env[key] = value;
				}
			} catch {
				// Missing or malformed env files are ignored; explicit env still works.
			}
		}
	}
}

function applyLocalDefaults(): void {
	if (!isSea()) return;
	if (!process.env.RELAY_FLAVOR) process.env.RELAY_FLAVOR = "local";
}

loadEnvFiles();
applyLocalDefaults();
ensureRuntime();
await import("@vvtxn/cli");
