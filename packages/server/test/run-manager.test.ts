// RunManager lifecycle tests: run conflicts, cancellation, approvals, and the
// run_state snapshot for late subscribers.

import { Effect } from "effect";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { BoxLease, BoxManager, BoxSpec, BoxStatus, ExecResult } from "@vvtxn/box/types.ts";
import type { ServerEvent } from "@vvtxn/client/protocol.ts";
import type { LLMProvider } from "@vvtxn/relay/api/types.ts";
import { RunConflictError, RunManager } from "../run.ts";
import {
	chunks,
	chunksThenHangUntilAborted,
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

async function setupRun(provider: LLMProvider | null, boxes?: BoxManager) {
	const cwd = await mkdtemp(join(tmpdir(), "relay-run-test-"));
	const config = makeConfig(cwd);
	const store = new MemorySessionStore();
	const handle = store.create({ ownerId: USER_ID, cwd }) as MemorySessionHandle;
	const runs = new RunManager({ config, providerFor: () => Effect.succeed(provider), ...(boxes ? { boxes } : {}) });
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

/** Minimal box manager: records exec calls and leases a temp workspace. */
class RecordingBoxManager implements BoxManager {
	readonly enabled = true;
	readonly commands: string[] = [];
	leases = 0;
	releases = 0;
	private readonly workspace: string;

	constructor(workspace: string) {
		this.workspace = workspace;
	}

	acquire(spec: BoxSpec): Effect.Effect<BoxLease> {
		this.leases += 1;
		const status: BoxStatus = {
			boxId: "box-1",
			sessionId: spec.sessionId,
			projectCwd: spec.projectCwd,
			workspace: this.workspace,
			state: "running",
			createdAt: new Date().toISOString(),
			lastUsedAt: new Date().toISOString(),
		};
		return Effect.succeed({
			status,
			workspace: this.workspace,
			exec: (command: string): Effect.Effect<ExecResult> => {
				this.commands.push(command);
				return Effect.succeed({
					code: 0,
					stdout: "box-ok\n",
					stderr: "",
					durationMs: 1,
					truncated: false,
				});
			},
			release: () =>
				Effect.sync(() => {
					this.releases += 1;
				}),
		});
	}

	status(): Effect.Effect<BoxStatus | null> {
		return Effect.succeed(null);
	}

	stop(): Effect.Effect<void> {
		return Effect.void;
	}

	destroy(): Effect.Effect<void> {
		return Effect.void;
	}

	gc(): Effect.Effect<{ removed: number; trashed: number }> {
		return Effect.succeed({ removed: 0, trashed: 0 });
	}

	reconcile(): Effect.Effect<void> {
		return Effect.void;
	}

	shutdown(): Effect.Effect<void> {
		return Effect.void;
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

	it("executes a gated tool after an allow decision", async () => {
		const provider = new ScriptedProvider([
			chunks(toolCallChunk("call-1", "bash", JSON.stringify({ command: "printf hi > a.txt" })), doneChunk()),
			chunks(doneChunk()),
		]);
		const { cwd, runs, sessionId } = await setupRun(provider);
		const run = collect(runs, sessionId);

		runs.startMessage(sessionId, "run a command");
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
			chunks(toolCallChunk("call-1", "bash", JSON.stringify({ command: "printf hi > a.txt" })), doneChunk()),
			chunks(doneChunk()),
		]);
		const { cwd, runs, sessionId } = await setupRun(provider);
		const run = collect(runs, sessionId);

		runs.startMessage(sessionId, "run a command");
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
					{ id: "call-1", name: "bash", args: JSON.stringify({ command: "printf one > a.txt" }) },
					{ id: "call-2", name: "bash", args: JSON.stringify({ command: "printf two > b.txt" }) },
				),
				doneChunk(),
			),
			chunks(doneChunk()),
		]);
		const { cwd, runs, sessionId } = await setupRun(provider);
		const run = collect(runs, sessionId);

		runs.startMessage(sessionId, "run two commands");
		const approval = await waitForEvent(run.events, "approval_required");
		runs.resolveApproval(sessionId, approval.approval.toolCallId, "always");
		await run.finished();

		expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("one");
		expect(await readFile(join(cwd, "b.txt"), "utf8")).toBe("two");
		expect(run.events.filter((event) => event.type === "approval_required")).toHaveLength(1);
		run.unsubscribe();
	});

	it("runs confined file mutations without approval, creating parent directories", async () => {
		const provider = new ScriptedProvider([
			chunks(
				twoToolCallsChunk(
					{ id: "call-1", name: "write_file", args: JSON.stringify({ path: "a.txt", content: "one" }) },
					{
						id: "call-2",
						name: "write_file",
						args: JSON.stringify({ path: "src/nested/b.txt", content: "two" }),
					},
				),
				doneChunk(),
			),
			chunks(doneChunk()),
		]);
		const { cwd, runs, sessionId } = await setupRun(provider);
		const run = collect(runs, sessionId);

		runs.startMessage(sessionId, "write two files");
		const finished = await run.finished();

		expect(finished.reason).toBe("completed");
		expect(run.events.some((event) => event.type === "approval_required")).toBe(false);
		expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("one");
		expect(await readFile(join(cwd, "src/nested/b.txt"), "utf8")).toBe("two");
		run.unsubscribe();
	});

	it("denies pending approvals when the run is cancelled", async () => {
		const provider = new ScriptedProvider([
			chunks(toolCallChunk("call-1", "bash", JSON.stringify({ command: "printf hi > a.txt" })), doneChunk()),
		]);
		const { cwd, runs, sessionId } = await setupRun(provider);
		const run = collect(runs, sessionId);

		runs.startMessage(sessionId, "run a command");
		const approval = await waitForEvent(run.events, "approval_required");
		runs.cancel(sessionId);
		const finished = await run.finished();

		expect(finished.reason).toBe("cancelled");
		const resolved = run.events.find((event) => event.type === "approval_resolved");
		expect(resolved).toMatchObject({ toolCallId: approval.approval.toolCallId, decision: "deny" });
		expect(await fileExists(join(cwd, "a.txt"))).toBe(false);
		run.unsubscribe();
	});

	it("exposes a run_state snapshot while a run is active", async () => {
		const provider = new ScriptedProvider([chunksThenHangUntilAborted(textChunk("partial"))]);
		const { runs, sessionId } = await setupRun(provider);

		runs.startMessage(sessionId, "hello");
		await waitFor(() => runs.getRunState(sessionId)?.draftText === "partial");

		const snapshot = runs.getRunState(sessionId);
		expect(snapshot).toMatchObject({
			type: "run_state",
			draftText: "partial",
			toolCalls: [],
			pendingApproval: null,
			tokens: 0,
			cost: 0,
		});

		runs.cancel(sessionId);
		await waitFor(() => !runs.isRunning(sessionId));
		expect(runs.getRunState(sessionId)).toBeNull();
	});

	it("delivers events to a subscriber that attaches mid-run", async () => {
		const provider = new ScriptedProvider([chunksThenHangUntilAborted(textChunk("partial"))]);
		const { runs, sessionId } = await setupRun(provider);

		runs.startMessage(sessionId, "hello");
		await waitFor(() => runs.getRunState(sessionId)?.draftText === "partial");

		// Attach after the run already started (late SSE subscriber).
		const run = collect(runs, sessionId);
		runs.cancel(sessionId);
		const finished = await run.finished();

		expect(finished.reason).toBe("cancelled");
		run.unsubscribe();
	});

	it("supports sequential runs on the same session", async () => {
		const provider = new ScriptedProvider([
			chunks(textChunk("one"), doneChunk()),
			chunks(textChunk("two"), doneChunk()),
		]);
		const { runs, sessionId, handle } = await setupRun(provider);
		const run = collect(runs, sessionId);

		runs.startMessage(sessionId, "first");
		expect((await run.finished()).reason).toBe("completed");

		runs.startMessage(sessionId, "second");
		await waitFor(() => !runs.isRunning(sessionId));

		expect(runs.activeCount).toBe(0);
		const entries = handle.getEntries();
		expect(entries.map((entry) => entry.type)).toEqual(["message", "message", "message", "message"]);
		expect(entries[3]).toMatchObject({ type: "message", role: "assistant", content: "two" });
		run.unsubscribe();
	});

	it("cancels a run immediately after it starts", async () => {
		const provider = new ScriptedProvider([hangUntilAborted()]);
		const { runs, sessionId } = await setupRun(provider);
		const run = collect(runs, sessionId);

		runs.startMessage(sessionId, "hello");
		expect(runs.cancel(sessionId)).toBe(true);
		const finished = await run.finished();

		expect(finished.reason).toBe("cancelled");
		expect(runs.activeCount).toBe(0);
		run.unsubscribe();
	});

	it("runs delegate calls and rolls subagent cost into the session", async () => {
		const provider = new ScriptedProvider([
			chunks(
				toolCallChunk(
					"call-1",
					"delegate",
					JSON.stringify({ prompt: "Find the answer", description: "investigate" }),
				),
				doneChunk(),
			),
			chunks(
				textChunk("The answer is 42"),
				usageChunk({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.05 }),
			),
			chunks(textChunk("Thanks"), doneChunk()),
		]);
		const { runs, sessionId, handle } = await setupRun(provider);
		const run = collect(runs, sessionId);

		runs.startMessage(sessionId, "delegate this");
		const finished = await run.finished();

		expect(finished.reason).toBe("completed");
		// The prompt is rendered from the run's registry, so the subagent tool is
		// documented for the main agent.
		expect(provider.requests[0]?.messages[0]?.content).toContain("**delegate**");
		// The parent's follow-up request carries the subagent's report.
		const parentFollowUp = provider.requests[2];
		expect(
			parentFollowUp?.messages.some(
				(message) => message.role === "tool" && message.content?.includes("The answer is 42"),
			),
		).toBe(true);
		// The subagent loop only sees the read-only workspace tools.
		const subagentTools = provider.requests[1]?.tools?.map((tool) => tool.function.name).sort();
		expect(subagentTools).toEqual(["grep", "read_file"]);
		expect(handle.getCost()).toBe(0.05);
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

	it("routes bash through the box lease and releases it when the run ends", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "relay-box-run-test-"));
		const boxes = new RecordingBoxManager(workspace);
		const provider = new ScriptedProvider([
			chunks(toolCallChunk("call-1", "bash", JSON.stringify({ command: "echo hi" })), doneChunk()),
			chunks(doneChunk()),
		]);
		const { runs, sessionId } = await setupRun(provider, boxes);
		const run = collect(runs, sessionId);

		runs.startMessage(sessionId, "run it");
		const finished = await run.finished();

		expect(finished.reason).toBe("completed");
		expect(boxes.commands).toEqual(["echo hi"]);
		expect(boxes.leases).toBe(1);
		expect(boxes.releases).toBe(1);
		expect(run.events.some((event) => event.type === "approval_required")).toBe(false);
		const result = await waitForEvent(run.events, "tool_result");
		expect(result.result.content).toContain("box-ok");
		run.unsubscribe();
	});
});
