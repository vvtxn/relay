/** Browser storage for client-side preferences. Never throws (private mode, SSR). */

const SERVER_URL_KEY = "relay.serverUrl";
const CWD_KEY = "relay.cwd";

/**
 * Empty means same-origin. That is the default so the app works in both dev
 * (Vite proxies `/api` to the server) and production (the server serves the
 * SPA and API from one origin). Set `relay.serverUrl` in localStorage to point
 * at a different server, which then needs to allow the browser origin.
 */
const DEFAULT_SERVER_URL = "";

/** The old client persisted this absolute default; treat it as "unset". */
const LEGACY_DEFAULT_URLS = new Set(["http://127.0.0.1:7433", "http://localhost:7433"]);

function read(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Storage unavailable — preference is simply not persisted.
	}
}

export function readStoredServerUrl(): string {
	const stored = read(SERVER_URL_KEY)?.replace(/\/+$/, "");
	if (!stored || LEGACY_DEFAULT_URLS.has(stored)) return DEFAULT_SERVER_URL;
	return stored;
}

export function writeStoredServerUrl(url: string): void {
	write(SERVER_URL_KEY, url.replace(/\/+$/, ""));
}

export function readStoredCwd(): string | null {
	return read(CWD_KEY);
}

export function writeStoredCwd(cwd: string): void {
	write(CWD_KEY, cwd);
}
