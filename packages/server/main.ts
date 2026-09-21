import { serverConfigFromEnv } from "./config.ts";
import { createServices } from "./services.ts";
import { handleRequest } from "./router.ts";

/** Entry point for `relay serve`. */
export function startServer(): void {
	const config = serverConfigFromEnv();
	const services = createServices(config);

	console.log(`Relay server listening on http://${config.hostname}:${config.port}`);
	console.log(`Mode: ${config.relayEnv}`);
	console.log(`Auth provider: ${config.authProvider}`);
	if (config.authProvider === "github") {
		console.log(`OAuth callback: ${config.publicUrl}/api/auth/callback`);
	}
	if (config.staticDir) console.log(`Serving web app from ${config.staticDir}`);

	Deno.serve(
		{ port: config.port, hostname: config.hostname },
		(request, info) => handleRequest(services, request, info),
	);
}

// Run when executed directly (deno run packages/server/main.ts)
if (import.meta.main) {
	startServer();
}
