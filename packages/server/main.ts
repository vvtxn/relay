import { dirname } from "@std/path/dirname";
import { type ServerConfig, serverConfigFromEnv } from "./config.ts";
import { createServices } from "./services.ts";
import { handleRequest } from "./router.ts";

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
		Deno.writeTextFileSync(path, JSON.stringify(state, null, "\t") + "\n", { mode: 0o600 });
	} catch (error) {
		console.error("Failed to write server state:", error instanceof Error ? error.message : error);
	}
}

/** Entry point for `relay serve`. */
export function startServer(): void {
	const config = serverConfigFromEnv();
	const services = createServices(config);

	console.log(`Relay server listening on http://${config.hostname}:${config.port}`);
	console.log(`Mode: ${config.relayEnv}`);
	console.log(`Auth provider: ${config.authProvider}`);
	if (config.authProvider === "github") {
		console.log(
			`OAuth callback: ${config.publicUrl}/api/auth/callback (must match a GitHub App callback URL exactly)`,
		);
	}
	if (config.staticDir) console.log(`Serving web app from ${config.staticDir}`);

	const server = Deno.serve(
		{ port: config.port, hostname: config.hostname },
		(request, info) => handleRequest(services, request, info),
	);
	writeServerState(config, server);
}

// Run when executed directly (deno run packages/server/main.ts)
if (import.meta.main) {
	startServer();
}
