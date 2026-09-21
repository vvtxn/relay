import { assertEquals } from "@std/assert";
import { RunManager } from "./run.ts";
import type { ServerConfig } from "./config.ts";
import type { SessionHandle, SessionStore } from "@vvtxn/relay/core/sessions/index.ts";
import type { LLMProvider } from "@vvtxn/relay/api/types.ts";
import type { ServerEvent } from "@vvtxn/client/protocol.ts";

function fakeConfig(): ServerConfig {
	return {
		relayEnv: "development",
		port: 0,
		hostname: "127.0.0.1",
		apiKey: "test",
		baseURL: "http://localhost",
		model: "test",
		temperature: 0.1,
		maxTokens: 100_000,
		preserveRecentTurns: 6,
		maxCompletionTokens: 1024,
		tursoUrl: "turso://test",
		tursoToken: "token",
		authProvider: "local",
		devAuthSubject: "dev",
		githubClientId: null,
		githubClientSecret: null,
		publicUrl: "http://127.0.0.1:0",
		sessionTtlDays: 30,
		allowLocalAuth: true,
		defaultCwd: "/tmp",
		workspaceRoots: [],
		allowedGithub: [],
		staticDir: null,
	};
}

function fakeProvider(): LLMProvider {
	return {
		complete() {
			throw new Error("not implemented");
		},
		stream() {
			return (async function* () {
				yield {
					id: "gen-1",
					object: "chat.completion.chunk",
					created: 0,
					model: "test",
					choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
				};
				yield {
					id: "gen-1",
					object: "chat.completion.chunk",
					created: 0,
					model: "test",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" as const }],
				};
			})();
		},
	};
}

function fakeHandle(): SessionHandle {
	return {
		append: () => Promise.resolve("id"),
		getEntries: () => [],
		getHeader: () => ({
			type: "session",
			version: 1,
			id: "s1",
			timestamp: new Date().toISOString(),
			cwd: "/tmp",
		}),
		getTokens: () => 0,
		setTokens: () => {},
		getCost: () => 0,
		setCost: () => {},
		flush: () => Promise.resolve(),
	};
}

function fakeStore(): SessionStore {
	return {
		create: () => fakeHandle(),
		continueRecent: () => Promise.resolve(null),
		open: () => Promise.resolve(fakeHandle()),
		listSummaries: () => Promise.resolve([]),
	};
}

function makeManager(): RunManager {
	return new RunManager({ config: fakeConfig(), sessionStore: fakeStore(), provider: fakeProvider() });
}

Deno.test("RunManager - isRunning is false before any run", () => {
	const runs = makeManager();
	assertEquals(runs.isRunning("s1"), false);
});

Deno.test("RunManager - handles are owner-scoped", () => {
	const runs = makeManager();
	runs.attachHandle("s1", fakeHandle(), "user-1");

	assertEquals(runs.hasHandle("s1", "user-1"), true);
	assertEquals(runs.hasHandle("s1", "user-2"), false);
	assertEquals(runs.hasHandle("s1"), true);
	assertEquals(runs.getHandle("s1", "user-1") !== null, true);
	assertEquals(runs.getHandle("s1", "user-2"), null);
});

Deno.test("RunManager - releases an idle session when its last subscriber leaves", () => {
	const runs = makeManager();
	runs.attachHandle("s1", fakeHandle(), "user-1");
	const unsubscribe = runs.subscribe("s1", () => {});
	assertEquals(runs.hasHandle("s1", "user-1"), true);

	unsubscribe();

	assertEquals(runs.hasHandle("s1", "user-1"), false);
});

Deno.test("RunManager - releases the handle after a run finishes unwatched", async () => {
	const runs = makeManager();
	runs.attachHandle("s1", fakeHandle(), "user-1");

	runs.startMessage("s1", "hi");
	for (let i = 0; i < 100 && runs.isRunning("s1"); i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}

	assertEquals(runs.isRunning("s1"), false);
	assertEquals(runs.hasHandle("s1", "user-1"), false);
});

Deno.test("RunManager - subscribers receive events", async () => {
	const runs = makeManager();
	runs.attachHandle("s1", fakeHandle(), "user-1");

	const events: ServerEvent[] = [];
	const unsubscribe = runs.subscribe("s1", (event) => events.push(event));

	runs.startMessage("s1", "hello");
	await new Promise((resolve) => setTimeout(resolve, 200));
	unsubscribe();

	assertEquals(events.some((e) => e.type === "text_delta" && e.content === "hello"), true);
	assertEquals(events.some((e) => e.type === "run_finished"), true);
	assertEquals(runs.isRunning("s1"), false);
});

Deno.test("RunManager - second message on a running session throws RunConflictError", () => {
	// A provider that streams slowly so the run is still active
	const slowProvider: LLMProvider = {
		complete() {
			throw new Error("not implemented");
		},
		async *stream() {
			yield {
				id: "gen-1",
				object: "chat.completion.chunk",
				created: 0,
				model: "test",
				choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
			};
			await new Promise((resolve) => setTimeout(resolve, 300));
		},
	};
	const runs = new RunManager({ config: fakeConfig(), sessionStore: fakeStore(), provider: slowProvider });
	runs.attachHandle("s1", fakeHandle(), "user-1");

	runs.startMessage("s1", "first");
	assertEquals(runs.isRunning("s1"), true);

	let conflict = false;
	try {
		runs.startMessage("s1", "second");
	} catch (error) {
		conflict = (error as Error).name === "RunConflictError";
	}
	assertEquals(conflict, true);
});

Deno.test("RunManager - cancel aborts the run and emits run_finished", async () => {
	const slowProvider: LLMProvider = {
		complete() {
			throw new Error("not implemented");
		},
		async *stream(request) {
			yield {
				id: "gen-1",
				object: "chat.completion.chunk",
				created: 0,
				model: "test",
				choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
			};
			// Simulate a hanging stream that only unblocks on abort
			await new Promise<void>((resolve) => {
				if (request.signal?.aborted) return resolve();
				request.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			throw new Error("aborted");
		},
	};
	const runs = new RunManager({ config: fakeConfig(), sessionStore: fakeStore(), provider: slowProvider });
	runs.attachHandle("s1", fakeHandle(), "user-1");

	const events: ServerEvent[] = [];
	runs.subscribe("s1", (event) => events.push(event));

	runs.startMessage("s1", "hello");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assertEquals(runs.isRunning("s1"), true);

	runs.cancel("s1");
	await new Promise((resolve) => setTimeout(resolve, 200));

	assertEquals(runs.isRunning("s1"), false);
	assertEquals(events.some((e) => e.type === "run_finished"), true);
});

Deno.test("RunManager - getRunState returns null when no run is active", () => {
	const runs = makeManager();
	assertEquals(runs.getRunState("s1"), null);
});
