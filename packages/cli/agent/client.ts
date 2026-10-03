import { RelayClient } from "@vvtxn/client/client.ts";
import { readStoredSession } from "@vvtxn/relay/core/auth/session-file.ts";
import { resolveServerUrl } from "./config.ts";

/**
 * Authenticate CLI requests with the token handed over by a browser GitHub
 * login (loopback only). The token is read per request so signing in through
 * `/web` takes effect without restarting the TUI.
 */
function cliFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const token = readStoredSession()?.token ?? null;
	if (!token) return fetch(input, init);
	const headers = new Headers(init?.headers);
	headers.set("Authorization", `Bearer ${token}`);
	return fetch(input, { ...init, headers });
}

// The server URL is resolved lazily: `index.ts` sets `RELAY_SERVER_URL` after
// `ensureServer()` runs, but this module may be imported earlier (e.g. by the
// `workspace` command), so a module-level constant would freeze the wrong port.
let cachedClient: RelayClient | null = null;

/** The server URL this CLI talks to (env override, else `~/.relay/config.json`). */
export function serverUrl(): string {
	return resolveServerUrl();
}

/** The shared CLI client, built on first use so it sees the resolved URL. */
export function getClient(): RelayClient {
	return cachedClient ??= new RelayClient({ baseUrl: serverUrl(), fetch: cliFetch });
}

/** Build a client for an explicit server URL, reusing the CLI's bearer fetch. */
export function createClient(baseUrl: string): RelayClient {
	return new RelayClient({ baseUrl, fetch: cliFetch });
}
