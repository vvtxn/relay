import { RelayClient } from "@vvtxn/client/client.ts";
import { readStoredServerUrl } from "./storage.ts";

/**
 * Fetch wrapper that always sends cookies.
 *
 * Today the server runs single-user local auth, but the client is written for
 * the upcoming OAuth transport: session cookies (or any credential-bearing
 * scheme) flow without changing call sites. When OAuth lands, only the server
 * auth provider changes — this stays the same.
 */
function browserFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	return fetch(input, { ...init, credentials: "include" });
}

export const serverUrl = readStoredServerUrl();

/** Human-readable server location for errors and settings. */
export const serverLabel = serverUrl || globalThis.location?.origin || "same origin";

export const client = new RelayClient({ baseUrl: serverUrl, fetch: browserFetch });
