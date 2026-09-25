import { startServer } from "@vvtxn/server/main.ts";
import { ensureServer, printStatus, runWeb, stopServer } from "./server.ts";

const command = Deno.args[0];

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
			// The CLI is the entry point: guarantee a server, then run the TUI
			// against it. The server keeps running for the browser after exit.
			const state = await ensureServer({ cwd: Deno.cwd() });
			Deno.env.set("RELAY_SERVER_URL", state.url);
			await import("./app.tsx");
		}
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	Deno.exit(1);
}
