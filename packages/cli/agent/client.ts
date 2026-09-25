import { RelayClient } from "@vvtxn/client/client.ts";
import { readStoredSession } from "@vvtxn/relay/core/auth/session-file.ts";
import { resolveAuthSubject, resolveServerUrl } from "./config.ts";

export const serverUrl = resolveServerUrl();
const authSubject = resolveAuthSubject();

/**
 * Authenticate CLI requests. A token handed over by a browser GitHub login
 * (loopback only) takes precedence so the CLI acts as the same user as the web;
 * otherwise the local dev-subject bridge applies. The token is read per request
 * so signing in through `/web` takes effect without restarting the TUI.
 */
function cliFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const token = readStoredSession()?.token ?? null;
	if (!token && !authSubject) return fetch(input, init);
	const headers = new Headers(init?.headers);
	if (token) headers.set("Authorization", `Bearer ${token}`);
	else if (authSubject) headers.set("X-Relay-Local-Subject", authSubject);
	return fetch(input, { ...init, headers });
}

export const client = new RelayClient({ baseUrl: serverUrl, fetch: cliFetch });
