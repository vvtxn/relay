import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expandHome } from "@vvtxn/relay/core/display.ts";
import { homeDir, relayDir } from "@vvtxn/relay/core/paths.ts";

/** How the CLI picks its palette. */
const themeModes = ["auto", "dark", "light"] as const;
export type ThemeMode = (typeof themeModes)[number];

export function isThemeMode(value: unknown): value is ThemeMode {
	return typeof value === "string" && (themeModes as readonly string[]).includes(value);
}

export interface RelayConfig {
	/** Base URL of the Relay server this CLI talks to. */
	serverUrl: string;
	/**
	 * Palette preference: `auto` derives it from the terminal's colors, while
	 * `dark` and `light` use the built-in Graphite palettes.
	 */
	theme: ThemeMode;
}

const defaults: RelayConfig = {
	serverUrl: "http://127.0.0.1:7433",
	theme: "auto",
};

function loadUserConfig(): Partial<RelayConfig> {
	const path = join(relayDir(), "config.json");
	try {
		const raw = readFileSync(path, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return {};
		const record = parsed as Record<string, unknown>;
		const config: Partial<RelayConfig> = {};
		if (typeof record.serverUrl === "string" && record.serverUrl !== "") config.serverUrl = record.serverUrl;
		if (isThemeMode(record.theme)) config.theme = record.theme;
		return config;
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

/** Session explicitly requested by `relay attach` or `--session`. */
export function requestedSession(): string | null {
	const value = process.env.RELAY_CLI_SESSION?.trim();
	return value ? value : null;
}
