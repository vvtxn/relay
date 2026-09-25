/**
 * Supervises the background Relay server shared by the TUI and the browser.
 *
 * `relay` and `relay web` call {@link ensureServer}: they attach to a healthy
 * server (tracked in `~/.relay/server.json`) or start one detached, so a single
 * backend serves every client. The server writes its own state file (PID, port,
 * web URL) at startup; the CLI only reads it.
 */

import { dirname, fromFileUrl, join } from "@std/path";
import { relayDir } from "@vvtxn/relay/core/paths.ts";
import { openBrowser } from "./open.ts";

const DEFAULT_PORT = 7433;
const HEALTH_TIMEOUT_MS = 1_000;
const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;

export interface ServerState {
	url: string;
	port: number;
	pid: number;
	startedAt: string;
	cwd: string;
	/** Origin where the browser client is reachable. */
	webUrl: string;
}

function statePath(): string {
	return join(relayDir(), "server.json");
}

function logPath(): string {
	return join(relayDir(), "logs", "server.log");
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readState(): ServerState | null {
	try {
		const parsed = JSON.parse(Deno.readTextFileSync(statePath())) as Partial<ServerState>;
		if (
			typeof parsed.url !== "string" ||
			typeof parsed.port !== "number" ||
			typeof parsed.pid !== "number"
		) {
			return null;
		}
		return {
			url: parsed.url,
			port: parsed.port,
			pid: parsed.pid,
			startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
			cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
			webUrl: typeof parsed.webUrl === "string" ? parsed.webUrl : parsed.url,
		};
	} catch {
		return null;
	}
}

function clearState(): void {
	try {
		Deno.removeSync(statePath());
	} catch {
		// Already gone.
	}
}

async function isHealthy(url: string): Promise<boolean> {
	try {
		const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
		if (!response.ok) return false;
		const body = await response.json() as { status?: string };
		return body.status === "ok";
	} catch {
		return false;
	}
}

function preferredPort(): number {
	const explicit = Number(Deno.env.get("RELAY_PORT"));
	if (Number.isInteger(explicit) && explicit > 0) return explicit;
	const publicUrl = Deno.env.get("RELAY_PUBLIC_URL");
	if (publicUrl) {
		try {
			const port = Number(new URL(publicUrl).port);
			if (Number.isInteger(port) && port > 0) return port;
		} catch {
			// Not a URL — fall through to the default.
		}
	}
	return DEFAULT_PORT;
}

/** Return the preferred port when free, otherwise a freshly chosen free one. */
async function pickPort(preferred: number): Promise<number> {
	try {
		const server = Deno.serve({ port: preferred, hostname: "127.0.0.1", onListen: () => {} }, () => new Response());
		await server.shutdown();
		return preferred;
	} catch {
		const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, () => new Response());
		const port = (server.addr as Deno.NetAddr).port;
		await server.shutdown();
		return port;
	}
}

/** Arguments that re-launch this program as a foreground server. */
function serverArgs(): string[] {
	if (Deno.build.standalone) return ["serve"];
	const entry = fromFileUrl(new URL("../../server/main.ts", import.meta.url));
	return ["run", "--unstable-raw-imports", "--allow-all", entry];
}

function spawnServer(port: number, cwd: string): void {
	const stateFile = statePath();
	Deno.mkdirSync(dirname(stateFile), { recursive: true });
	Deno.mkdirSync(dirname(logPath()), { recursive: true });

	const env: Record<string, string> = {
		...Deno.env.toObject(),
		RELAY_WORKSPACE: cwd,
		RELAY_PORT: String(port),
		RELAY_STATE_FILE: stateFile,
	};
	if (!env.RELAY_PUBLIC_URL) env.RELAY_PUBLIC_URL = `http://127.0.0.1:${port}`;

	const args = serverArgs();
	const command = Deno.build.os === "windows"
		? new Deno.Command(Deno.execPath(), {
			args,
			env,
			stdin: "null",
			stdout: "null",
			stderr: "null",
		})
		: new Deno.Command("setsid", {
			args: ["sh", "-c", 'exec "$@" >>"$RELAY_SERVER_LOG" 2>&1', "sh", Deno.execPath(), ...args],
			env: { ...env, RELAY_SERVER_LOG: logPath() },
			stdin: "null",
		});

	const child = command.spawn();
	child.unref();
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	let wait = 50;
	while (Date.now() < deadline) {
		if (await isHealthy(url)) return true;
		await delay(wait);
		wait = Math.min(wait * 2, 500);
	}
	return false;
}

async function waitForState(port: number, timeoutMs: number): Promise<ServerState | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const state = readState();
		if (state && state.port === port && state.pid > 0) return state;
		await delay(50);
	}
	return readState();
}

/**
 * Resolve a usable server. An explicit `RELAY_SERVER_URL` is attached to, never
 * managed. Otherwise a healthy background server is reused, or a new one is
 * started detached with `cwd` as its workspace.
 */
export async function ensureServer(options: { cwd: string }): Promise<ServerState> {
	const explicit = Deno.env.get("RELAY_SERVER_URL");
	if (explicit) {
		const url = explicit.replace(/\/+$/, "");
		if (!(await isHealthy(url))) throw new Error(`Cannot reach the Relay server at ${url}.`);
		return {
			url,
			port: new URL(url).port ? Number(new URL(url).port) : 0,
			pid: 0,
			startedAt: "",
			cwd: options.cwd,
			webUrl: url,
		};
	}

	const existing = readState();
	if (existing && await isHealthy(existing.url)) return existing;
	if (existing) clearState();

	const port = await pickPort(preferredPort());
	spawnServer(port, options.cwd);
	const url = `http://127.0.0.1:${port}`;
	if (!(await waitForHealth(url, START_TIMEOUT_MS))) {
		throw new Error(`Relay server failed to start; see ${logPath()}`);
	}
	return await waitForState(port, 2_000) ??
		{ url, port, pid: 0, startedAt: "", cwd: options.cwd, webUrl: Deno.env.get("RELAY_PUBLIC_URL") ?? url };
}

/** Stop the background server recorded in the state file. */
export async function stopServer(): Promise<void> {
	const state = readState();
	if (!state) {
		console.log("No background Relay server.");
		return;
	}
	if (!(await isHealthy(state.url))) {
		clearState();
		console.log("Relay server is not running (cleared stale state).");
		return;
	}
	if (state.pid > 0) {
		try {
			Deno.kill(state.pid, "SIGTERM");
		} catch (error) {
			console.error(`Failed to signal the server: ${error instanceof Error ? error.message : error}`);
		}
	}
	const deadline = Date.now() + STOP_TIMEOUT_MS;
	while (Date.now() < deadline && await isHealthy(state.url)) await delay(100);
	clearState();
	console.log("Relay server stopped.");
}

/** Print the background server's status. */
export async function printStatus(): Promise<void> {
	const state = readState();
	if (!state) {
		console.log("No background Relay server.");
		return;
	}
	const alive = await isHealthy(state.url);
	console.log(`Server:    ${state.url} (${alive ? "running" : "not responding"})`);
	console.log(`Workspace: ${state.cwd}`);
	console.log(`Web:       ${state.webUrl}`);
	if (state.pid > 0) console.log(`PID:       ${state.pid}`);
}

async function isReachable(url: string): Promise<boolean> {
	try {
		await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
		return true;
	} catch {
		return false;
	}
}

/** `relay web`: ensure a server, open the browser, then return (or stay watching). */
export async function runWeb(args: string[]): Promise<void> {
	const foreground = args.includes("--foreground");
	const state = await ensureServer({ cwd: Deno.cwd() });
	let webUrl = state.webUrl || state.url;

	// In development the web origin is Vite (e.g. localhost:5173); if that is
	// not running, fall back to the web app the server itself serves.
	if (webUrl !== state.url && !(await isReachable(webUrl))) {
		console.log(`Web client at ${webUrl} is not running; using the server's bundled web app.`);
		webUrl = state.url;
	}

	openBrowser(webUrl);
	console.log(`Relay is running at ${webUrl}`);

	if (!foreground) return;
	console.log("Watching in the foreground; press Ctrl-C to detach (the server keeps running).");
	await new Promise<void>((resolve) => {
		const onSignal = () => resolve();
		Deno.addSignalListener("SIGINT", onSignal);
	});
}
