import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expandHome } from "@vvtxn/relay/core/display.ts";
import { homeDir, relayDir } from "@vvtxn/relay/core/paths.ts";

export interface RelayConfig {
	/** Base URL of the Relay server this CLI talks to. */
	serverUrl: string;
}

const defaults: RelayConfig = {
	serverUrl: "http://127.0.0.1:7433",
};

function loadUserConfig(): Partial<RelayConfig> {
	const path = join(relayDir(), "config.json");
	try {
		const raw = readFileSync(path, "utf8");
		return JSON.parse(raw) as Partial<RelayConfig>;
	} catch {
		try {
			const dir = relayDir();
			mkdirSync(dir, { recursive: true });
			writeFileSync(path, JSON.stringify(defaults, null, "\t") + "\n");
		} catch {
			/* ignore — read-only fs or similar */
		}
		return {};
	}
}

export const config: RelayConfig = { ...defaults, ...loadUserConfig() };

/** Environment overrides the config file. */
export function resolveServerUrl(): string {
	return process.env.RELAY_SERVER_URL ?? config.serverUrl;
}

/** Expand `~` and resolve a user-supplied directory to an absolute path. */
export function resolveWorkspacePath(input: string): string {
	const home = homeDir();
	const expanded = home && (input === "~" || input.startsWith("~/")) ? expandHome(input, home) : input;
	return resolve(expanded);
}

/**
 * The workspace the TUI is scoped to: `--workspace` (canonicalized by the
 * server at startup), else the launch directory.
 */
export function workspaceCwd(): string {
	return process.env.RELAY_CLI_WORKSPACE ?? process.cwd();
}

/** True when the CLI was launched with `-c`/`--continue`. */
export function resumeRequested(): boolean {
	return process.env.RELAY_CLI_RESUME === "1";
}
