import { startServer } from "@vvtxn/server/main.ts";
import { readStoredSession } from "@vvtxn/relay/core/auth/session-file.ts";
import { ensureServer, printStatus, runWeb, type ServerState, stopServer } from "./server.ts";
import { openBrowser } from "./open.ts";

const command = Deno.args[0];
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

async function fetchJson<T>(url: string, headers?: HeadersInit): Promise<T | null> {
	try {
		const response = await fetch(url, {
			...(headers ? { headers } : {}),
			signal: AbortSignal.timeout(2_000),
		});
		if (!response.ok) return null;
		return await response.json() as T;
	} catch {
		return null;
	}
}

/** True when this CLI currently has valid credentials for the server. */
async function isAuthorized(serverUrl: string): Promise<boolean> {
	const token = readStoredSession()?.token;
	try {
		const response = await fetch(`${serverUrl}/api/me`, {
			...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
			signal: AbortSignal.timeout(2_000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * In GitHub mode the CLI has no session until a browser login. Open the web
 * client and wait for the token handoff (`~/.relay/session.json`), so the
 * terminal and the browser act as the same user.
 */
async function ensureAuthenticated(state: ServerState): Promise<void> {
	const info = await fetchJson<{ provider?: string }>(`${state.url}/api/auth/info`);
	if (info?.provider !== "github") return;
	if (await isAuthorized(state.url)) return;

	const webUrl = state.webUrl || state.url;
	console.log(`Not signed in. Opening ${webUrl} — sign in with GitHub to continue.`);
	openBrowser(webUrl);

	const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		if (await isAuthorized(state.url)) {
			console.log("Signed in.");
			return;
		}
	}
	throw new Error("Sign-in timed out. Open the web client, sign in, then run `relay` again.");
}

try {
	switch (command) {
		case "serve":
			startServer();
			break;
		case "web":
			await runWeb(Deno.args.slice(1));
			break;
		case "stop":
			await stopServer();
			break;
		case "status":
			await printStatus();
			break;
		default: {
			// The CLI is the entry point: guarantee a server, ensure a session,
			// then run the TUI. The server keeps running for the browser.
			const state = await ensureServer({ cwd: Deno.cwd() });
			Deno.env.set("RELAY_SERVER_URL", state.url);
			await ensureAuthenticated(state);
			await import("./app.tsx");
		}
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	Deno.exit(1);
}
