import { serverConfigFromEnv } from "./config.ts";
import { createServices } from "./services.ts";
import { handleRequest } from "./router.ts";

/** Entry point for `relay serve`. */
export async function startServer(): Promise<void> {
	const config = serverConfigFromEnv();
	const services = await createServices(config);

	console.log(`Relay server listening on http://${config.hostname}:${config.port}`);
	console.log(`Signed in as ${services.user.name ?? services.user.id}`);
	if (config.staticDir) console.log(`Serving web app from ${config.staticDir}`);

	Deno.serve({ port: config.port, hostname: config.hostname }, (request) => handleRequest(services, request));
}

// Run when executed directly (deno run packages/server/main.ts)
if (import.meta.main) {
	await startServer();
}
