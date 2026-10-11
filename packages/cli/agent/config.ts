import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { relayDir } from "@vvtxn/relay/core/paths.ts";

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
