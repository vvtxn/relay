/**
 * `relay box` — inspect and control managed boxes without launching the TUI.
 * The server owns the lifecycle; these commands attach to the running daemon.
 */

import { resolve } from "node:path";
import type { RelayClient } from "@vvtxn/client/client.ts";
import { ensureAuthenticated, ensureServer } from "./server.ts";
import { createClient } from "./client.ts";

function usage(): void {
	console.log(
		[
			"Usage:",
			"  relay box new [path] [tiny|small|medium]",
			"  relay box list",
			"  relay box pause|resume|stop <boxId>",
			"  relay box sync <boxId>",
			"  relay box resize <boxId> <tiny|small|medium>",
			"  relay box attach <boxId> <sessionId>",
			"  relay box detach <boxId> <sessionId>",
			"  relay box rm <boxId>",
		].join("\n"),
	);
}

async function withClient<T>(fn: (client: RelayClient) => Promise<T>): Promise<T> {
	const state = await ensureServer({ cwd: process.cwd() });
	process.env.RELAY_SERVER_URL = state.url;
	await ensureAuthenticated(state);
	return await fn(createClient(state.url));
}

async function create(args: string[]): Promise<void> {
	const target = resolve(args[0] && !["tiny", "small", "medium"].includes(args[0]) ? args[0] : ".");
	const candidate = args.find((arg) => arg === "tiny" || arg === "small" || arg === "medium");
	const profile = candidate === "tiny" || candidate === "small" || candidate === "medium" ? candidate : undefined;
	await withClient(async (client) => {
		const { box } = await client.createBox(target, profile);
		console.log(`${box.boxId}  ${box.profile}  ${box.cpus} vCPU/${box.memoryMiB} MiB  ${box.state}`);
	});
}

async function list(): Promise<void> {
	await withClient(async (client) => {
		const { boxes } = await client.listBoxes();
		if (boxes.length === 0) {
			console.log("No boxes yet. Send a message, or run `relay box new`.");
			return;
		}
		for (const box of boxes) {
			const attachments = box.attachments.length > 0 ? box.attachments.join(", ") : "none";
			const capacity = box.capacity
				? `  ${box.capacity.running}/${box.capacity.maxRunning} boxes, ` +
					`${box.capacity.usedMemoryMiB}/${box.capacity.maxMemoryMiB} MiB`
				: "";
			console.log(
				`${box.boxId}  ${box.state.padEnd(8)}  ${box.profile.padEnd(6)}  ` +
					`${box.cpus} vCPU/${box.memoryMiB} MiB  sessions: ${attachments}${capacity}`,
			);
		}
	});
}

async function action(sub: "pause" | "resume" | "stop", args: string[]): Promise<void> {
	const boxId = args[0];
	if (!boxId) {
		usage();
		process.exit(1);
	}
	await withClient(async (client) => {
		if (sub === "pause") await client.pauseBox(boxId);
		else if (sub === "resume") await client.resumeBox(boxId);
		else await client.stopBox(boxId);
		console.log(`${sub[0]?.toUpperCase()}${sub.slice(1)}d ${boxId}`);
	});
}

async function sync(args: string[]): Promise<void> {
	const boxId = args[0];
	if (!boxId) {
		usage();
		process.exit(1);
	}
	await withClient(async (client) => {
		const result = await client.syncBox(boxId);
		console.log(result.summary);
	});
}

async function resize(args: string[]): Promise<void> {
	const [boxId, profile] = args;
	if (!boxId || (profile !== "tiny" && profile !== "small" && profile !== "medium")) {
		usage();
		process.exit(1);
	}
	await withClient(async (client) => {
		const { box } = await client.resizeBox(boxId, profile);
		console.log(`${box.boxId}  ${box.profile}  ${box.cpus} vCPU/${box.memoryMiB} MiB`);
	});
}

async function attach(args: string[], detach: boolean): Promise<void> {
	const [boxId, sessionId] = args;
	if (!boxId || !sessionId) {
		usage();
		process.exit(1);
	}
	await withClient(async (client) => {
		if (detach) await client.detachBox(boxId, sessionId);
		else await client.attachBox(boxId, sessionId);
		console.log(`${detach ? "Detached" : "Attached"} ${sessionId} ${detach ? "from" : "to"} ${boxId}`);
	});
}

async function remove(args: string[]): Promise<void> {
	const boxId = args[0];
	if (!boxId) {
		usage();
		process.exit(1);
	}
	await withClient(async (client) => {
		await client.removeBox(boxId);
		console.log(`Removed ${boxId}`);
	});
}

export async function runBoxCommand(args: string[]): Promise<void> {
	const sub = args[0];
	const rest = args.slice(1);
	switch (sub) {
		case "new":
		case "create":
			await create(rest);
			return;
		case "list":
			await list();
			return;
		case "pause":
		case "resume":
		case "stop":
			await action(sub, rest);
			return;
		case "sync":
			await sync(rest);
			return;
		case "resize":
			await resize(rest);
			return;
		case "attach":
			await attach(rest, false);
			return;
		case "detach":
			await attach(rest, true);
			return;
		case "rm":
		case "remove":
			await remove(rest);
			return;
		default:
			usage();
			if (sub) process.exit(1);
	}
}
