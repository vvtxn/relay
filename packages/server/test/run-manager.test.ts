// TEMP(effect-migration): characterization tests for the RunManager rewrite
// (phase 2, structured concurrency). Remove after phase 2 — see
// docs/effect-migration.md ("Testing strategy").

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { ServerEvent } from "@vvtxn/client/protocol.ts";
import type { LLMProvider } from "@vvtxn/relay/api/types.ts";
import { RunConflictError, RunManager } from "../run.ts";
import {
	chunks,
	doneChunk,
	hangUntilAborted,
	makeConfig,
	MemorySessionHandle,
	MemorySessionStore,
	ScriptedProvider,
	textChunk,
	toolCallChunk,
	twoToolCallsChunk,
	usageChunk,
	waitFor,
} from "./helpers.ts";

const USER_ID = "user-1";

async function setupRun(provider: LLMProvider | null) {
	const cwd = await mkdtemp(join(tmpdir(), "relay-run-test-"));
	const config = makeConfig(cwd);
	const store = new MemorySessionStore();
	const handle = store.create({ ownerId: USER_ID, cwd }) as MemorySessionHandle;
	const runs = new RunManager({ config, sessionStore: store, providerFor: async () => provider });
	const sessionId = handle.getHeader().id;
	runs.attachHandle(sessionId, handle, USER_ID);
	return { cwd, runs, sessionId, handle };
}

function collect(runs: RunManager, sessionId: string) {
	const events: ServerEvent[] = [];
	const finishWaiters: Array<(event: ServerEvent) => void> = [];
	const unsubscribe = runs.subscribe(sessionId, (event) => {
		events.push(event);
		if (event.type === "run_finished") {
			for (const resolve of finishWaiters.splice(0)) resolve(event);
		}
	});
	return {
		events,
		unsubscribe,
		finished(timeoutMs = 4000): Promise<Extract<ServerEvent, { type: "run_finished" }>> {
			const existing = events.find((event) => event.type === "run_finished");
			if (existing) return Promise.resolve(existing as Extract<ServerEvent, { type: "run_finished" }>);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("run did not finish in time")), timeoutMs);
				finishWaiters.push((event) => {
					clearTimeout(timer);
					resolve(event as Extract<ServerEvent, { type: "run_finished" }>);
				});
			});
		},
	};
}

async function waitForEvent<T extends ServerEvent["type"]>(
	events: ServerEvent[],
	type: T,
	timeoutMs = 2000,
): Promise<Extract<ServerEvent, { type: T }>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = events.find((event) => event.type === type);
		if (found) return found as Extract<ServerEvent, { type: T }>;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`event ${type} not received in time`);
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await readFile(path);
		return true;
	} catch {
		return false;
	}
}

describe("RunManager", () => {
	it("rejects a second message while a run is active, then cancels cleanly", async () => {
		const provider = new ScriptedProvider([hangUntilAborted(), chunks(textChunk("late"), doneChunk())]);
		const { runs, sessionId } = await setupRun(provider);
		const run = collect(runs, sessionId);

		runs.startMessage(sessionId, "first");
		expect(runs.isRunning(sessionId)).toBe(true);
		expect(() => runs.startMessage(sessionId, "second")).toThrow(RunConflictError);

		await waitFor(() => provider.requests.length === 1);
		runs.cancel(sessionId);
		const finished = await run.finished();

		expect(finished.reason).toBe("cancelled");
		expect(run.events.some((event) => event.type === "error")).toBe(false);
		expect(runs.isRunning(sessionId)).toBe(false);
		run.unsubscribe();
	});

	it("executes a side-effecting tool after an allow decision", async () => {
		const provider = new ScriptedProvider([
			chunks(
				toolCallChunk("call-1", "write_file", JSON.stringify({ path: "a.txt", content: "hi" })),
				doneChunk(),
			),
			chunks(doneChunk()),
		]);
		const { cwd, runs, sessionId } = await setupRun(provider);
		const run = collect(runs, sessionId);

		runs.startMessage(sessionId, "write a file");
		const approval = await waitForEvent(run.events, "approval_required");
		expect(runs.resolveApproval(sessionId, approval.approval.toolCallId, "allow")).toBe(true);
		const finished = await run.finished();

		expect(finished.reason).toBe("completed");
		expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("hi");
		const result = await waitForEvent(run.events, "tool_result");
		expect(result.id).toBe("call-1");
		expect(result.result.isError).not.toBe(true);
		expect(run.events.some((event) => event.type === "approval_resolved" && event.decision === "allow")).toBe(true);
		run.unsubscribe();
	});

	it("returns a denial as an error tool result and does not run the tool", async () => {
		const provider = new ScriptedProvider([
			chunks(
				toolCallChunk("call-1", "write_file", JSON.stringify({ path: "a.txt", content: "hi" })),
				doneChunk(),
			),
			chunks(doneChunk()),
		]);
		const { cwd, runs, sessionId } = await setupRun(provider);
		const run = collect(runs, sessionId);

		runs.startMessage(sessionId, "write a file");
		const approval = await waitForEvent(run.events, "approval_required");
		expect(runs.resolveApproval(sessionId, approval.approval.toolCallId, "deny")).toBe(true);
		await run.finished();

		expect(await fileExists(join(cwd, "a.txt"))).toBe(false);
		const result = await waitForEvent(run.events, "tool_result");
		expect(result.result.isError).toBe(true);
		expect(result.result.content).toContain("denied");
		run.unsubscribe();
	});

	it("skips approval for later calls after an always decision", async () => {
		const provider = new ScriptedProvider([
			chunks(
				twoToolCallsChunk(
					{ id: "call-1", name: "write_file", args: JSON.stringify({ path: "a.txt", content: "one" }) },
					{ id: "call-2", name: "write_file", args: JSON.stringify({ path: "b.txt", content: "two" }) },
				),
				doneChunk(),
			),
			chunks(doneChunk()),
		]);
		const { cwd, runs, sessionId } = await setupRun(provider);
		const run = collect(runs, sessionId);

		runs.startMessage(sessionId, "write two files");
		const approval = await waitForEvent(run.events, "approval_required");
		runs.resolveApproval(sessionId, approval.approval.toolCallId, "always");
		await run.finished();

		expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("one");
		expect(await readFile(join(cwd, "b.txt"), "utf8")).toBe("two");
		expect(run.events.filter((event) => event.type === "approval_required")).toHaveLength(1);
		run.unsubscribe();
	});

	it("denies pending approvals when the run is cancelled", async () => {
		const provider = new ScriptedProvider([
			chunks(
				toolCallChunk("call-1", "write_file", JSON.stringify({ path: "a.txt", content: "hi" })),
				doneChunk(),
			),
		]);
		const { cwd, runs, sessionId } = await setupRun(provider);
		const run = collect(runs, sessionId);

		runs.startMessage(sessionId, "write a file");
		const approval = await waitForEvent(run.events, "approval_required");
		runs.cancel(sessionId);
		const finished = await run.finished();

		expect(finished.reason).toBe("cancelled");
		const resolved = run.events.find((event) => event.type === "approval_resolved");
		expect(resolved).toMatchObject({ toolCallId: approval.approval.toolCallId, decision: "deny" });
		expect(await fileExists(join(cwd, "a.txt"))).toBe(false);
		run.unsubscribe();
	});

	it("persists entries and usage, and tracks tokens and cost", async () => {
		const provider = new ScriptedProvider([
			chunks(
				textChunk("Hello "),
				textChunk("world"),
				usageChunk({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.002 }),
			),
		]);
		const { runs, sessionId, handle } = await setupRun(provider);
		const run = collect(runs, sessionId);

		runs.startMessage(sessionId, "hello");
		await run.finished();

		const entries = handle.getEntries();
		expect(entries.map((entry) => entry.type)).toEqual(["message", "message"]);
		expect(entries[0]).toMatchObject({ type: "message", role: "user", content: "hello" });
		expect(entries[1]).toMatchObject({ type: "message", role: "assistant", content: "Hello world" });
		expect(handle.getTokens()).toBe(15);
		expect(handle.getCost()).toBe(0.002);
		run.unsubscribe();
	});

	it("releases the cached handle once the run is idle and unwatched", async () => {
		const provider = new ScriptedProvider([chunks(textChunk("hi"), doneChunk())]);
		const { runs, sessionId } = await setupRun(provider);
		const run = collect(runs, sessionId);

		runs.startMessage(sessionId, "hello");
		await run.finished();

		expect(runs.hasHandle(sessionId)).toBe(true);
		expect(runs.getRunState(sessionId)).toBeNull();
		run.unsubscribe();
		expect(runs.hasHandle(sessionId)).toBe(false);
	});

	it("fails the run with a clear message when no provider is configured", async () => {
		const { runs, sessionId } = await setupRun(null);
		const run = collect(runs, sessionId);

		runs.startMessage(sessionId, "hello");
		const finished = await run.finished();

		expect(finished.reason).toBe("error");
		const errorEvent = await waitForEvent(run.events, "error");
		expect(errorEvent.message).toContain("No API key configured");
		run.unsubscribe();
	});
});
