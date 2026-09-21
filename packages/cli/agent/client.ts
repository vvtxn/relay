import { RelayClient } from "@vvtxn/client/client.ts";
import { resolveAuthSubject, resolveServerUrl } from "./config.ts";

export const serverUrl = resolveServerUrl();
const authSubject = resolveAuthSubject();

/** Attach the local-auth subject header when the CLI bridge is configured. */
function cliFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	if (!authSubject) return fetch(input, init);
	const headers = new Headers(init?.headers);
	headers.set("X-Relay-Local-Subject", authSubject);
	return fetch(input, { ...init, headers });
}

export const client = new RelayClient({ baseUrl: serverUrl, fetch: cliFetch });
