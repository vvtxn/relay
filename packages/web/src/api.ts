import { RelayClient } from "@vvtxn/client/client.ts";

const SERVER_URL_STORAGE_KEY = "relay.serverUrl";
const DEFAULT_SERVER_URL = "http://127.0.0.1:7433";

function resolveServerUrl(): string {
	try {
		return (localStorage.getItem(SERVER_URL_STORAGE_KEY) ?? DEFAULT_SERVER_URL).replace(/\/+$/, "");
	} catch {
		return DEFAULT_SERVER_URL;
	}
}

export function setServerUrl(url: string): void {
	try {
		localStorage.setItem(SERVER_URL_STORAGE_KEY, url.replace(/\/+$/, ""));
	} catch {
		// Private mode — ignore
	}
}

export const client = new RelayClient({ baseUrl: resolveServerUrl() });
export const serverUrl = resolveServerUrl();
