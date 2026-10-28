import { startServer } from "@vvtxn/server/main.ts";
import { VERSION } from "@vvtxn/relay/version.ts";
import { createClient } from "./client.ts";
import { resolveWorkspacePath } from "./config.ts";
import { ensureApiKey, ensureAuthenticated, ensureServer, printStatus, runWeb, stopServer } from "./server.ts";
import { runFontsCommand } from "./fonts.ts";
import { runWorkspaceCommand } from "./workspace.ts";
import { runBoxCommand } from "./box.ts";

const args = process.argv.slice(2);
const command = args[0];

/** Flags for the default command: `relay [--continue] [--workspace <path>]`. */
function parseRunFlags(argv: string[]): { resume: boolean; workspace: string | null } {
	let resume = false;
	let workspace: string | null = null;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "-c" || arg === "--continue") {
			resume = true;
		} else if (arg === "--workspace") {
			const value = argv[index + 1];
			if (!value) throw new Error("--workspace requires a directory path");
			workspace = value;
			index += 1;
		} else if (arg?.startsWith("-")) {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	return { resume, workspace };
}

try {
	switch (command) {
		case "version":
		case "--version":
		case "-v":
			console.log(VERSION);
			break;
		case "serve":
			await startServer();
			break;
		case "web":
			await runWeb(args.slice(1));
			break;
		case "stop":
			await stopServer();
			break;
		case "status":
			await printStatus();
			break;
		case "fonts":
			await runFontsCommand(args.slice(1));
			break;
		case "workspace":
			await runWorkspaceCommand(args.slice(1));
			break;
		case "box":
			await runBoxCommand(args.slice(1));
			break;
		default: {
			// The CLI is the entry point: guarantee a server, ensure a session,
			// then run the TUI. The server keeps running for the browser.
			const flags = parseRunFlags(args);
			const state = await ensureServer({ cwd: process.cwd() });
			process.env.RELAY_SERVER_URL = state.url;
			if (flags.resume) process.env.RELAY_CLI_RESUME = "1";
			await ensureAuthenticated(state);
			// `--workspace` scopes the TUI to another directory: the server
			// validates and registers it, and its canonical path becomes the
			// scope for every session the TUI creates or lists.
			if (flags.workspace) {
				const { workspace } = await createClient(state.url).registerWorkspace(
					resolveWorkspacePath(flags.workspace),
				);
				process.env.RELAY_CLI_WORKSPACE = workspace.cwd;
			}
			// The agent needs an LLM API key, entered only in the web Settings
			// page; block here until one is saved rather than opening a TUI that
			// cannot send a message.
			await ensureApiKey(state);
			await import("./app.tsx");
		}
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
