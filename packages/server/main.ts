import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type ServerConfig, serverConfigFromEnv } from "./config.ts";
import { createServices } from "./services.ts";
import { handleRequest } from "./router.ts";
import { startHttpServer, type RunningServer } from "./http-server.ts";

/**
 * Exit code used when the configured port is taken (`EX_TEMPFAIL` from
 * sysexits). The CLI supervisor treats it as a port conflict: it attaches to a
 * healthy server that won the race, or falls back to a free port in
 * development, instead of reporting a generic startup failure.
 */
const EXIT_ADDR_IN_USE = 75;

function isAddrInUse(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}

function bindFailure(config: ServerConfig, error: Error): string {
	return [
		`Relay server cannot listen on ${config.hostname}:${config.port}: the address is already in use.`,
		"Another process (possibly a stale Relay server) is holding the port.",
		"Run `relay stop` to stop a tracked background server, free the port, or set RELAY_PORT to a different port.",
		`(${error.message})`,
	].join("\n");
}

/**
 * Write a small state file so the CLI supervisor can find and later stop this
 * server. Only used when the launcher sets `RELAY_STATE_FILE` (the background
 * daemon); a plain `relay serve` leaves no state behind.
 */
function writeServerState(config: ServerConfig, server: RunningServer): void {
	const path = process.env.RELAY_STATE_FILE;
	if (!path) return;
	const host = config.hostname === "0.0.0.0" || config.hostname === "::" ? "127.0.0.1" : config.hostname;
	const state = {
		url: `http://${host}:${server.port}`,
		port: server.port,
		pid: process.pid,
		startedAt: new Date().toISOString(),
		cwd: config.defaultCwd,
		webUrl: config.publicUrl,
	};
	try {
		mkdirSync(dirname(path), { recursive: true });
		// Write-then-rename so a reader never observes a partial file.
		const tmp = `${path}.${process.pid}.tmp`;
		try {
			writeFileSync(tmp, JSON.stringify(state, null, "\t") + "\n", { mode: 0o600 });
			renameSync(tmp, path);
		} catch (error) {
			try {
				rmSync(tmp, { force: true });
			} catch {
				// Best effort cleanup.
			}
			throw error;
		}
	} catch (error) {
		console.error("Failed to write server state:", error instanceof Error ? error.message : error);
	}
}

/** Entry point for `relay serve`. */
export async function startServer(): Promise<void> {
	const config = serverConfigFromEnv();
	const services = await createServices(config);

	console.log(`Mode: ${config.relayEnv}`);
	console.log(`Workspace: ${config.defaultCwd}`);
	console.log(
		`Workspace roots: ${config.workspaceRoots.length > 0 ? config.workspaceRoots.join(", ") : "(any directory)"}`,
	);
	console.log(`OAuth callback: ${config.publicUrl}/api/auth/callback (must match a GitHub App callback URL exactly)`);
	if (config.staticDir) console.log(`Serving web app from ${config.staticDir}`);

	let server: RunningServer;
	try {
		server = await startHttpServer({ port: config.port, hostname: config.hostname }, (request) =>
			handleRequest(services, request),
		);
	} catch (error) {
		if (isAddrInUse(error)) {
			console.error(bindFailure(config, error));
			process.exit(EXIT_ADDR_IN_USE);
		}
		throw error;
	}

	console.log(`Relay server listening on http://${config.hostname}:${server.port}`);
	writeServerState(config, server);
}

// Run when executed directly (node packages/server/main.ts)
if (import.meta.main) {
	await startServer();
}
