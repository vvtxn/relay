import { startServer } from "@vvtxn/server/main.ts";
import { ensureApiKey, ensureAuthenticated, ensureServer, printStatus, runWeb, stopServer } from "./server.ts";
import { runFontsCommand } from "./fonts.ts";
import { runWorkspaceCommand } from "./workspace.ts";

const command = Deno.args[0];

try {
	switch (command) {
		case "serve":
			await startServer();
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
		case "fonts":
			await runFontsCommand(Deno.args.slice(1));
			break;
		case "workspace":
			await runWorkspaceCommand(Deno.args.slice(1));
			break;
		default: {
			// The CLI is the entry point: guarantee a server, ensure a session,
			// then run the TUI. The server keeps running for the browser.
			const state = await ensureServer({ cwd: Deno.cwd() });
			Deno.env.set("RELAY_SERVER_URL", state.url);
			await ensureAuthenticated(state);
			// The agent needs an LLM API key, entered only in the web Settings
			// page; block here until one is saved rather than opening a TUI that
			// cannot send a message.
			await ensureApiKey(state);
			await import("./app.tsx");
		}
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	Deno.exit(1);
}
