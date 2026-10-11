import { dirname } from "@std/path/dirname";
import { type ServerConfig, serverConfigFromEnv } from "./config.ts";
import { createServices } from "./services.ts";
import { handleRequest } from "./router.ts";

/**
 * Exit code used when the configured port is taken (`EX_TEMPFAIL` from
 * sysexits). The CLI supervisor treats it as a port conflict: it attaches to a
 * healthy server that won the race, or falls back to a free port in
 * development, instead of reporting a generic startup failure.
 */
const EXIT_ADDR_IN_USE = 75;

function isAddrInUse(error: unknown): error is Error {
	return error instanceof Error && error.name === "AddrInUse";
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
function writeServerState(config: ServerConfig, server: Deno.HttpServer): void {
	const path = Deno.env.get("RELAY_STATE_FILE");
	if (!path) return;
	const address = server.addr as Deno.NetAddr;
	const host = config.hostname === "0.0.0.0" || config.hostname === "::" ? "127.0.0.1" : config.hostname;
	const state = {
		url: `http://${host}:${address.port}`,
		port: address.port,
		pid: Deno.pid,
		startedAt: new Date().toISOString(),
		cwd: config.defaultCwd,
		webUrl: config.publicUrl,
	};
	try {
		Deno.mkdirSync(dirname(path), { recursive: true });
		// Write-then-rename so a reader never observes a partial file.
		const tmp = `${path}.${Deno.pid}.tmp`;
		try {
			Deno.writeTextFileSync(tmp, JSON.stringify(state, null, "\t") + "\n", { mode: 0o600 });
			Deno.renameSync(tmp, path);
		} catch (error) {
			try {
				Deno.removeSync(tmp);
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
	console.log(
		`OAuth callback: ${config.publicUrl}/api/auth/callback (must match a GitHub App callback URL exactly)`,
	);
	if (config.staticDir) console.log(`Serving web app from ${config.staticDir}`);

	let server: Deno.HttpServer;
	try {
		server = Deno.serve(
			{ port: config.port, hostname: config.hostname, onListen: () => {} },
			(request) => handleRequest(services, request),
		);
	} catch (error) {
		if (isAddrInUse(error)) {
			console.error(bindFailure(config, error));
			Deno.exit(EXIT_ADDR_IN_USE);
		}
		throw error;
	}

	const address = server.addr as Deno.NetAddr;
	console.log(`Relay server listening on http://${config.hostname}:${address.port}`);
	writeServerState(config, server);
}

// Run when executed directly (deno run packages/server/main.ts)
if (import.meta.main) {
	await startServer();
}
