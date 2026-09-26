import { join } from "@std/path/join";
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
		const raw = Deno.readTextFileSync(path);
		return JSON.parse(raw) as Partial<RelayConfig>;
	} catch {
		try {
			const dir = relayDir();
			Deno.mkdirSync(dir, { recursive: true });
			Deno.writeTextFileSync(path, JSON.stringify(defaults, null, "\t") + "\n");
		} catch { /* ignore — read-only fs or similar */ }
		return {};
	}
}

export const config: RelayConfig = { ...defaults, ...loadUserConfig() };

/** Environment overrides the config file. */
export function resolveServerUrl(): string {
	return Deno.env.get("RELAY_SERVER_URL") ?? config.serverUrl;
}
