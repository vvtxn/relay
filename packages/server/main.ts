import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { type ServerConfig, serverConfigFromEnv } from "./config.ts";
import { createServices } from "./services.ts";
import { createAppLayer } from "./router.ts";

/**
 * Exit code used when the configured port is taken (`EX_TEMPFAIL` from
 * sysexits). The CLI supervisor treats it as a port conflict: it attaches to a
 * healthy server that won the race, or falls back to a free port in
 * development, instead of reporting a generic startup failure.
 */
const EXIT_ADDR_IN_USE = 75;

/** True when the error (or a wrapped cause) is a bind conflict. */
function isAddrInUse(error: unknown): boolean {
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current != null; depth++) {
		if (current instanceof Error && (current as NodeJS.ErrnoException).code === "EADDRINUSE") return true;
		current = current instanceof Error ? current.cause : undefined;
	}
	return false;
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
function writeServerState(config: ServerConfig): void {
	const path = process.env.RELAY_STATE_FILE;
	if (!path) return;
	const host = config.hostname === "0.0.0.0" || config.hostname === "::" ? "127.0.0.1" : config.hostname;
	const state = {
		url: `http://${host}:${config.port}`,
		port: config.port,
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
	console.log(`Database: ${config.database.kind === "local" ? `local (${config.database.path})` : "turso"}`);
	console.log(`Auth: ${config.authMode}`);
	if (config.authMode === "github") {
		console.log(
			`OAuth callback: ${config.publicUrl}/api/auth/callback (must match a GitHub App callback URL exactly)`,
		);
	}
	if (config.staticDir) console.log(`Serving web app from ${config.staticDir}`);

	// Close the database before exiting so SQLite checkpoints its WAL. The
	// process is stopped by `relay stop` (SIGTERM) or Ctrl-C.
	let shuttingDown = false;
	const shutdown = (): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		try {
			services.db.close();
		} catch (error) {
			console.error("Failed to close the database:", error instanceof Error ? error.message : error);
		}
		process.exit(0);
	};
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);

	// Trim any pre-existing overflow before serving so every workspace starts
	// within the configured cap. No runs exist yet, so nothing active is at risk.
	try {
		const removed = await Effect.runPromise(services.sessionStore.pruneAll());
		if (removed > 0) {
			console.log(
				`Removed ${removed} old session(s); keeping at most ${config.maxSessionsPerWorkspace} per workspace.`,
			);
		}
	} catch (error) {
		console.error(
			"Failed to enforce the per-workspace session limit:",
			error instanceof Error ? error.message : error,
		);
	}

	const app = createAppLayer(services);
	const server = NodeHttpServer.layer(() => createServer(), { host: config.hostname, port: config.port });
	const serve = HttpRouter.serve(app).pipe(
		Layer.provideMerge(server),
		// Runs once the listener is bound: report the address and publish the
		// state file the CLI supervisor reads.
		Layer.tap(() =>
			Effect.sync(() => {
				console.log(`Relay server listening on http://${config.hostname}:${config.port}`);
				writeServerState(config);
			}),
		),
	);

	try {
		await Effect.runPromise(Layer.launch(serve));
	} catch (error) {
		if (isAddrInUse(error)) {
			console.error(bindFailure(config, error instanceof Error ? error : new Error(String(error))));
			process.exit(EXIT_ADDR_IN_USE);
		}
		throw error;
	}
}

// Run when executed directly (node packages/server/main.ts)
if (import.meta.main) {
	await startServer();
}
