import { RelayClient } from "@vvtxn/client/client.ts";
import { readStoredSession } from "@vvtxn/relay/core/auth/session-file.ts";
import { resolveServerUrl } from "./config.ts";

export const serverUrl = resolveServerUrl();

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

export const client = new RelayClient({ baseUrl: serverUrl, fetch: cliFetch });
