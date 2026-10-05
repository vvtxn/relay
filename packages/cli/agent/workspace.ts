/**
 * `relay workspace add|list|remove` — manage the server's workspaces without
 * launching the TUI.
 *
 * The server is the source of truth: `add` registers a validated directory
 * against the already-running background daemon (starting one if needed), so a
 * project can be added from any shell and immediately appears in the browser.
 */

import { resolve } from "@std/path";
import { abbreviateHome, expandHome } from "@vvtxn/relay/core/display.ts";
import { homeDir } from "@vvtxn/relay/core/paths.ts";
import type { RelayClient } from "@vvtxn/client/client.ts";
import { ensureAuthenticated, ensureServer, readState } from "./server.ts";
import { createClient } from "./client.ts";

function usage(): void {
	console.log(
		[
			"Usage:",
			"  relay workspace add [path]   Register a directory (default: current directory)",
			"  relay workspace list         List registered workspaces",
			"  relay workspace remove <path>  Unregister a workspace (sessions are kept)",
		].join("\n"),
	);
}

/** Expand a `~` prefix using the server's home directory when known. */
function expandTilde(input: string): string {
	const home = homeDir();
	return home && (input === "~" || input.startsWith("~/")) ? expandHome(input, home) : input;
}

/** Resolve a user-supplied path to an absolute one (the server rejects relative paths). */
function absolute(input: string): string {
	return resolve(expandTilde(input));
}

function display(path: string): string {
	const home = homeDir();
	return home ? abbreviateHome(path, home) : path;
}

async function withClient<T>(fn: (client: RelayClient) => Promise<T>): Promise<T> {
	const state = await ensureServer({ cwd: Deno.cwd() });
	Deno.env.set("RELAY_SERVER_URL", state.url);
	await ensureAuthenticated(state);
	return await fn(createClient(state.url));
}

async function add(args: string[]): Promise<void> {
	const target = absolute(args[0] ?? ".");
	await withClient(async (client) => {
		try {
			const { workspace } = await client.registerWorkspace(target);
			console.log(`Added workspace ${display(workspace.cwd)}`);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			Deno.exit(1);
		}
	});
}

async function list(): Promise<void> {
	await withClient(async (client) => {
		const { workspaces } = await client.listWorkspaces();
		if (workspaces.length === 0) {
			console.log("No workspaces yet. Run `relay workspace add` in a project directory.");
			return;
		}
		const state = readState();
		for (const workspace of workspaces) {
			const marks = [
				workspace.cwd === state?.cwd ? "default" : "",
				workspace.exists === false ? "missing" : "",
			].filter(Boolean);
			const suffix = marks.length > 0 ? `  (${marks.join(", ")})` : "";
			console.log(`${display(workspace.cwd)}  [${workspace.sessionCount} sessions]${suffix}`);
		}
	});
}

async function remove(args: string[]): Promise<void> {
	if (!args[0]) {
		console.error("Usage: relay workspace remove <path>");
		Deno.exit(1);
	}
	const target = absolute(args[0]);
	await withClient(async (client) => {
		await client.unregisterWorkspace(target);
		console.log(`Removed workspace ${display(target)}`);
	});
}

export async function runWorkspaceCommand(args: string[]): Promise<void> {
	const sub = args[0];
	switch (sub) {
		case "add":
			await add(args.slice(1));
			return;
		case "list":
			await list();
			return;
		case "remove":
		case "rm":
			await remove(args.slice(1));
			return;
		default:
			usage();
			if (sub) Deno.exit(1);
	}
}
