import { RelayClient } from "@vvtxn/client/client.ts";
import { readStoredServerUrl } from "./storage.ts";

/**
 * Fetch wrapper that always sends cookies.
 *
 * Auth is GitHub OAuth: the server issues an opaque `HttpOnly` session cookie,
 * so credential-bearing requests flow without changing API call sites.
 */
function browserFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	return fetch(input, { ...init, credentials: "include" });
}

export const serverUrl = readStoredServerUrl();

/** Human-readable server location for errors and settings. */
export const serverLabel = serverUrl || globalThis.location?.origin || "same origin";

export const client = new RelayClient({ baseUrl: serverUrl, fetch: browserFetch });
