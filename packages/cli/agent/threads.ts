import type { RunSummary, SessionSummary } from "@vvtxn/client/protocol.ts";
import { createClient } from "./client.ts";
import { workspaceCwd, type ThemeMode } from "./config.ts";
import { ensureApiKey, ensureAuthenticated, ensureServer } from "./server.ts";
import { parseThemeMode, prepareTheme } from "./theme.ts";

interface ThreadRow {
	cwd: string;
	session: SessionSummary;
	run: RunSummary | undefined;
}

function phaseLabel(run: RunSummary | undefined): string {
	if (!run) return "idle";
	if (run.phase === "queued" && run.queuePosition !== undefined) return `queued #${run.queuePosition}`;
	return run.phase.replace(/-/g, " ");
}

function preview(session: SessionSummary): string {
	if (!session.firstUserMessage) return "(empty thread)";
	return session.firstUserMessage.length > 48
		? `${session.firstUserMessage.slice(0, 48)}…`
		: session.firstUserMessage;
}

/** `relay threads [--all]` — list threads and their run state. */
export async function runThreads(args: string[]): Promise<void> {
	let all = false;
	for (const arg of args) {
		if (arg === "--all") all = true;
		else if (arg?.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
	}

	const state = await ensureServer({ cwd: process.cwd() });
	process.env.RELAY_SERVER_URL = state.url;
	await ensureAuthenticated(state);
	const client = createClient(state.url);

	const cwds = all ? (await client.listWorkspaces()).workspaces.map((workspace) => workspace.cwd) : [workspaceCwd()];
	const [sessionLists, runs] = await Promise.all([
		Promise.all(cwds.map(async (cwd) => ({ cwd, sessions: (await client.listSessions(cwd)).sessions }))),
		client.listRuns(),
	]);
	const runBySession = new Map(runs.runs.map((run) => [run.sessionId, run]));
	const rows: ThreadRow[] = sessionLists.flatMap(({ cwd, sessions }) =>
		sessions.map((session) => ({
			cwd,
			session,
			run: runBySession.get(session.id) ?? runBySession.get(session.reference),
		})),
	);

	if (rows.length === 0) {
		console.log(all ? "No threads." : `No threads in ${workspaceCwd()}.`);
		return;
	}

	const width = Math.min(48, Math.max(...rows.map((row) => preview(row.session).length)));
	for (const { cwd, session, run } of rows) {
		const stateLabel = phaseLabel(run).padEnd(18);
		const box = run?.boxId ? ` ${run.boxId}` : "";
		const workspace = all ? `  (${cwd})` : "";
		console.log(`${stateLabel}  ${preview(session).padEnd(width)}  ${session.reference}${box}${workspace}`);
	}
	console.log("");
	console.log("Attach with: relay attach <session>");
}

/** `relay attach <session>` — open the TUI on an existing thread. */
export async function runAttach(args: string[]): Promise<void> {
	let sessionId: string | null = null;
	let theme: ThemeMode | null = null;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--theme") {
			theme = parseThemeMode(args[index + 1]);
			index += 1;
		} else if (arg?.startsWith("-")) {
			throw new Error(`Unknown option: ${arg}`);
		} else if (sessionId === null) {
			sessionId = arg ?? null;
		} else {
			throw new Error(`Unexpected argument: ${arg}`);
		}
	}
	if (!sessionId) throw new Error("relay attach requires a session id (see `relay threads`)");

	const state = await ensureServer({ cwd: process.cwd() });
	process.env.RELAY_SERVER_URL = state.url;
	await ensureAuthenticated(state);
	await ensureApiKey(state);
	const session = await createClient(state.url).openSession(sessionId);
	process.env.RELAY_CLI_WORKSPACE = session.header.cwd;
	process.env.RELAY_CLI_SESSION = sessionId;
	await prepareTheme(theme);
	await import("./app.tsx");
}
