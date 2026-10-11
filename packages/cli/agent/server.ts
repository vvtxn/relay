/**
 * Supervises the background Relay server shared by the TUI and the browser.
 *
 * `relay` and `relay web` call {@link ensureServer}: they attach to a healthy
 * server (tracked in `~/.relay/server.json`) or start one detached, so a single
 * backend serves every client. The server binds its configured port, writes its
 * own state file (PID, port, web URL) once listening, and the CLI discovers the
 * actual URL from that file — it never assumes a port before the bind succeeds.
 *
 * Porting rules: `RELAY_PORT` (default 7433) is the only source for the listen
 * port; `RELAY_PUBLIC_URL` is the browser-facing origin (Vite in development)
 * and must never influence it. When the preferred port is taken by something
 * that is not a healthy Relay server, development falls back to a free
 * ephemeral port; production (or an explicit `RELAY_PORT`) fails with the
 * server log so the conflict is fixed rather than hidden.
 */

import { dirname, fromFileUrl, join } from "@std/path";
import type { SettingsResponse } from "@vvtxn/client/protocol.ts";
import { readStoredSession } from "@vvtxn/relay/core/auth/session-file.ts";
import { relayDir } from "@vvtxn/relay/core/paths.ts";
import { openBrowser } from "./open.ts";

const DEFAULT_PORT = 7433;
const HEALTH_TIMEOUT_MS = 1_000;
/** Cold starts (module compile + schema init) can far exceed the old 10s cap. */
const DEFAULT_START_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 5_000;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const API_KEY_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 100;
/** How long to look for a server another process may be starting after a port conflict. */
const CONFLICT_GRACE_MS = 3_000;
/** Preferred port plus two fallback ports (fallback is development-only). */
const MAX_START_ATTEMPTS = 3;
/** Exit code the server uses when its port is taken (`EX_TEMPFAIL` from sysexits). */
const EXIT_ADDR_IN_USE = 75;

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

/** Port the background server should use: explicit `RELAY_PORT`, else the default. */
function preferredPort(): number {
	const explicit = Number(Deno.env.get("RELAY_PORT"));
	if (Number.isInteger(explicit) && explicit > 0) return explicit;
	return DEFAULT_PORT;
}

/**
 * Whether the CLI may start the server on a fallback ephemeral port when the
 * preferred one is taken by something other than a healthy Relay server.
 * Development convenience only: an explicit `RELAY_PORT` is always respected,
 * and production deployments must surface a port conflict instead of hiding it.
 */
function portFallbackAllowed(): boolean {
	const explicit = Number(Deno.env.get("RELAY_PORT"));
	if (Number.isInteger(explicit) && explicit > 0) return false;
	return Deno.env.get("RELAY_ENV") !== "production";
}

function startTimeoutMs(): number {
	const raw = Number(Deno.env.get("RELAY_START_TIMEOUT_MS"));
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_START_TIMEOUT_MS;
}

function loopbackUrl(port: number): string {
	return `http://127.0.0.1:${port}`;
}

/** State for a healthy server the CLI attached to but did not spawn (no PID). */
function adoptedState(url: string, port: number, cwd: string): ServerState {
	return {
		url,
		port,
		pid: 0,
		startedAt: "",
		cwd,
		webUrl: (Deno.env.get("RELAY_PUBLIC_URL") ?? url).replace(/\/+$/, ""),
	};
}

/** Bind an ephemeral port, release it, and return the number. */
async function pickFreePort(): Promise<number> {
	const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, () => new Response());
	const port = (server.addr as Deno.NetAddr).port;
	await server.shutdown();
	return port;
}

/** Arguments that re-launch this program as a foreground server. */
function serverArgs(): string[] {
	if (Deno.build.standalone) return ["serve"];
	const entry = fromFileUrl(new URL("../../server/main.ts", import.meta.url));
	return ["run", "--unstable-raw-imports", "--allow-all", entry];
}

function spawnServer(port: number, cwd: string): Deno.ChildProcess {
	const stateFile = statePath();
	Deno.mkdirSync(dirname(stateFile), { recursive: true });
	Deno.mkdirSync(dirname(logPath()), { recursive: true });

	const env: Record<string, string> = {
		...Deno.env.toObject(),
		RELAY_WORKSPACE: cwd,
		RELAY_PORT: String(port),
		RELAY_STATE_FILE: stateFile,
	};

	const child = detachCommand(env, serverArgs()).spawn();
	child.unref();
	return child;
}

/**
 * A command that outlives the CLI. `setsid` moves the server into a new
 * session (so it survives the terminal closing) on Linux/BSD; macOS has no
 * `setsid`, so it uses `nohup`, whose ignored-SIGHUP disposition survives the
 * `exec`. Windows has neither — `unref()` alone is enough there.
 */
function detachCommand(env: Record<string, string>, args: string[]): Deno.Command {
	if (Deno.build.os === "windows") {
		return new Deno.Command(Deno.execPath(), {
			args,
			env,
			stdin: "null",
			stdout: "null",
			stderr: "null",
		});
	}

	const script = 'exec "$@" >>"$RELAY_SERVER_LOG" 2>&1';
	const logEnv = { ...env, RELAY_SERVER_LOG: logPath() };
	if (Deno.build.os === "darwin") {
		return new Deno.Command("nohup", {
			args: ["sh", "-c", script, "sh", Deno.execPath(), ...args],
			env: logEnv,
			stdin: "null",
			stdout: "null",
			stderr: "null",
		});
	}
	return new Deno.Command("setsid", {
		args: ["sh", "-c", script, "sh", Deno.execPath(), ...args],
		env: logEnv,
		stdin: "null",
	});
}

/** Last lines of the background server log, for startup failure messages. */
function readLogTail(maxLines = 15, maxBytes = 32 * 1024): string {
	try {
		const path = logPath();
		const size = Deno.statSync(path).size;
		const start = Math.max(0, size - maxBytes);
		const file = Deno.openSync(path, { read: true });
		try {
			if (start > 0) file.seekSync(start, Deno.SeekMode.Start);
			const buffer = new Uint8Array(size - start);
			let read = 0;
			while (read < buffer.length) {
				const chunk = file.readSync(buffer.subarray(read));
				if (chunk === null) break;
				read += chunk;
			}
			// deno-lint-ignore no-control-regex -- strip ANSI color codes from the log tail
			const text = new TextDecoder().decode(buffer.subarray(0, read)).replace(/\x1b\[[0-9;]*m/g, "");
			const lines = text.split("\n");
			if (start > 0) lines.shift();
			return lines.filter((line) => line.trim() !== "").slice(-maxLines).join("\n").trim();
		} finally {
			file.close();
		}
	} catch {
		return "";
	}
}

/** Build the error shown when the background server could not be started. */
function startupFailure(detail: string): Error {
	const parts = [`Relay server failed to start: ${detail}`];
	const tail = readLogTail();
	if (tail) parts.push("", "Last server log lines:", tail);
	parts.push("", `Full log: ${logPath()}`);
	return new Error(parts.join("\n"));
}

type StartOutcome =
	/** A healthy server is reachable. */
	| { kind: "started"; state: ServerState }
	/** The spawned server exited because its port is taken. */
	| { kind: "addr-in-use" }
	/** The spawned server exited for another reason (bad config, missing env…). */
	| { kind: "exited"; detail: string }
	/** The timeout elapsed while the server was still starting. */
	| { kind: "timeout"; detail: string };

/** Wait until the spawned server is healthy, exits, or the timeout elapses. */
async function awaitStart(child: Deno.ChildProcess, port: number, cwd: string): Promise<StartOutcome> {
	const startedAt = Date.now();
	const deadline = startedAt + startTimeoutMs();
	const exit: { status: Deno.CommandStatus | null } = { status: null };
	child.status.then((status) => {
		exit.status = status;
	}).catch(() => {});
	let hintShown = false;
	while (Date.now() < deadline) {
		const state = readState();
		if (state && state.pid > 0 && await isHealthy(state.url)) return { kind: "started", state };
		const url = loopbackUrl(port);
		if (await isHealthy(url)) return { kind: "started", state: adoptedState(url, port, cwd) };
		if (exit.status) {
			if (exit.status.code === EXIT_ADDR_IN_USE) return { kind: "addr-in-use" };
			return { kind: "exited", detail: `the server exited (code ${exit.status.code})` };
		}
		if (!hintShown && Date.now() - startedAt > 3_000) {
			hintShown = true;
			console.log("Waiting for the Relay server to start (the first run may take a while)…");
		}
		await delay(POLL_INTERVAL_MS);
	}
	const timeout = startTimeoutMs();
	return {
		kind: "timeout",
		detail: `the server did not become healthy within ${
			timeout >= 1_000 ? `${Math.round(timeout / 1_000)}s` : `${timeout}ms`
		}`,
	};
}

/** After a port conflict, give a server another process is starting a moment to appear. */
async function waitForRunningServer(preferred: number, cwd: string): Promise<ServerState | null> {
	const deadline = Date.now() + CONFLICT_GRACE_MS;
	while (Date.now() < deadline) {
		const state = readState();
		if (state && state.pid > 0 && await isHealthy(state.url)) return state;
		const url = loopbackUrl(preferred);
		if (await isHealthy(url)) return adoptedState(url, preferred, cwd);
		await delay(150);
	}
	return null;
}

/**
 * Resolve a usable server. An explicit `RELAY_SERVER_URL` is attached to, never
 * managed. Otherwise a healthy background server is reused (from the state file
 * or discovered on the preferred port), or a new one is started detached with
 * `cwd` as its workspace.
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

	// Adopt a healthy server on the preferred port even without a state file —
	// for example a foreground `relay serve` started outside the supervisor.
	const preferred = preferredPort();
	if (await isHealthy(loopbackUrl(preferred))) return adoptedState(loopbackUrl(preferred), preferred, options.cwd);

	const fallbackAllowed = portFallbackAllowed();
	let port = preferred;
	for (let attempt = 1;; attempt++) {
		const outcome = await awaitStart(spawnServer(port, options.cwd), port, options.cwd);
		if (outcome.kind === "started") return outcome.state;
		if (outcome.kind === "exited") throw startupFailure(outcome.detail);
		if (outcome.kind === "timeout") {
			throw startupFailure(`${outcome.detail} (it may still be starting; run \`relay\` again to attach)`);
		}

		// The port was taken from under us: another CLI may be bringing a server
		// up on it right now, so look before falling back.
		const winner = await waitForRunningServer(preferred, options.cwd);
		if (winner) return winner;
		if (!fallbackAllowed || attempt >= MAX_START_ATTEMPTS) {
			throw startupFailure(
				`port ${port} is already in use and is not answering as a Relay server. ` +
					`Stop the process holding it, or set RELAY_PORT to a free port.`,
			);
		}
		port = await pickFreePort();
	}
}

/** True when this CLI currently has valid credentials for the server. */
export async function isAuthorized(serverUrl: string): Promise<boolean> {
	return (await authStatus(serverUrl)).status === "authorized";
}

export type AuthStatus =
	| { status: "authorized" }
	/** The server answered but rejected the token (or none is stored). */
	| { status: "unauthenticated" }
	/** The server could not be reached or failed to resolve the session. */
	| { status: "unreachable"; detail: string };

/**
 * Probe `/api/me` and distinguish a rejected token (401) from a server that is
 * unreachable or failing (network error, 5xx). Treating the latter as "not
 * signed in" would send the user through the whole browser login flow for what
 * is really a database/server problem.
 */
export async function authStatus(serverUrl: string): Promise<AuthStatus> {
	const token = readStoredSession()?.token;
	try {
		const response = await fetch(`${serverUrl}/api/me`, {
			...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
			signal: AbortSignal.timeout(5_000),
		});
		if (response.ok) return { status: "authorized" };
		if (response.status === 401) return { status: "unauthenticated" };
		return { status: "unreachable", detail: `the server returned ${response.status}` };
	} catch (error) {
		return { status: "unreachable", detail: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * The CLI has no session until a browser login. Open the web client and wait
 * for the token handoff (`~/.relay/session.json`), so the terminal and the
 * browser act as the same user.
 */
export async function ensureAuthenticated(state: ServerState): Promise<void> {
	const status = await authStatus(state.url);
	if (status.status === "authorized") return;
	if (status.status === "unreachable") {
		throw new Error(
			`Cannot reach the Relay server at ${state.url} (${status.detail}). ` +
				`Check ${logPath()}, then run \`relay stop\` and \`relay\` again.`,
		);
	}

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

export type ApiKeyStatus =
	| { status: "configured" }
	/** Signed in, but no key has been saved yet. */
	| { status: "missing" }
	/** The stored token was rejected (or none is stored). */
	| { status: "unauthenticated" }
	/** The server could not be reached or failed to answer. */
	| { status: "unreachable"; detail: string };

/** Probe `/api/settings` for whether the caller has an LLM API key configured. */
export async function apiKeyStatus(serverUrl: string): Promise<ApiKeyStatus> {
	const token = readStoredSession()?.token;
	try {
		const response = await fetch(`${serverUrl}/api/settings`, {
			...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
			signal: AbortSignal.timeout(5_000),
		});
		if (response.status === 401) return { status: "unauthenticated" };
		if (!response.ok) return { status: "unreachable", detail: `the server returned ${response.status}` };
		const body = await response.json() as Partial<SettingsResponse> | null;
		// A malformed body counts as "missing": the TUI can only be entered once a
		// key is confirmed, and the user can always re-save it.
		return body?.apiKey?.set ? { status: "configured" } : { status: "missing" };
	} catch (error) {
		return { status: "unreachable", detail: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * The agent cannot run without an LLM API key, and the key is only ever entered
 * in the web Settings page. Open that page and wait for the key to be saved, so
 * the terminal never drops into the TUI in an unusable state.
 */
export async function ensureApiKey(state: ServerState): Promise<void> {
	const status = await apiKeyStatus(state.url);
	if (status.status === "configured") return;
	if (status.status === "unauthenticated") {
		throw new Error("Not signed in. Run `relay` again to sign in.");
	}
	if (status.status === "unreachable") {
		throw new Error(
			`Cannot reach the Relay server at ${state.url} (${status.detail}). ` +
				`Check ${logPath()}, then run \`relay stop\` and \`relay\` again.`,
		);
	}

	// In development the web origin is Vite (e.g. localhost:5173); fall back to
	// the web app the server itself serves when that is not running, so the user
	// is never sent to a dead page.
	let webOrigin = state.webUrl || state.url;
	if (webOrigin !== state.url && !(await isReachable(webOrigin))) {
		webOrigin = state.url;
	}

	const settingsUrl = new URL("/settings", webOrigin).toString();
	console.log(`No API key configured. Opening ${settingsUrl} — add one to continue.`);
	openBrowser(settingsUrl);

	const deadline = Date.now() + API_KEY_TIMEOUT_MS;
	let warned = false;
	while (Date.now() < deadline) {
		await delay(1_000);
		const current = await apiKeyStatus(state.url);
		if (current.status === "configured") {
			console.log("API key saved.");
			return;
		}
		if (current.status === "unauthenticated") {
			throw new Error("Signed out while waiting for the API key. Run `relay` again.");
		}
		if (current.status === "unreachable" && !warned) {
			// A transient blip (server restart) should not abort the wait; the
			// user can still save the key once it is back.
			warned = true;
			console.log(`Lost contact with the server (${current.detail}); waiting for it to return…`);
		}
	}
	throw new Error("Timed out waiting for an API key. Add one in the web Settings page, then run `relay` again.");
}

/** Stop the background server recorded in the state file. */ export async function stopServer(): Promise<void> {
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
	if (state.pid <= 0) {
		clearState();
		console.log(`The server at ${state.url} was not started by this CLI; stop it from its own process manager.`);
		return;
	}
	try {
		Deno.kill(state.pid, "SIGTERM");
	} catch (error) {
		console.error(`Failed to signal the server: ${error instanceof Error ? error.message : error}`);
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
