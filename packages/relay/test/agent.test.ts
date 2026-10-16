// Behavior tests for the agent loop: retry/backoff and the stream timeout run on
// virtual time; tool ordering runs on the live clock.
//
// `TestEnv` mirrors what @effect/vitest's `it.effect` provides (a TestClock
// layer); @effect/vitest itself cannot be used here because `vp test` runs a
// bundled Vitest and a second `vitest` instance resolves to the wrong runner.

import { describe, expect, it } from "vite-plus/test";
import { Duration, Effect, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import type { AgentConfig, AgentEvent } from "../core/agent.ts";
import { run } from "../core/agent.ts";
import { createToolRegistry, type Tool } from "../core/tools/types.ts";
import {
	chunks,
	doneChunk,
	fail,
	fakeTool,
	hang,
	providerError,
	ScriptedProvider,
	textChunk,
	toolCallsChunk,
} from "./helpers.ts";

const USER_MESSAGE = { role: "user", content: "hello" } as const;

const TestEnv = Layer.mergeAll(TestClock.layer());

function runTest<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
	return Effect.runPromise(effect.pipe(Effect.provide(TestEnv)));
}

function config(provider: ScriptedProvider, tools: Tool[] = [], overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		provider,
		tools: createToolRegistry(tools),
		model: "fake-model",
		systemPrompt: "You are a test agent.",
		...overrides,
	};
}

function collect(stream: Stream.Stream<AgentEvent>): Effect.Effect<AgentEvent[]> {
	return Stream.runCollect(stream).pipe(Effect.map((events) => Array.from(events)));
}

/**
 * Advances the TestClock in steps until the fiber completes. `TestClock.adjust`
 * only releases sleepers that are already registered, so a run that is still
 * spinning up needs scheduler turns before each adjustment.
 */
function joinDrivingClock<A, E>(fiber: Fiber.Fiber<A, E>, step: Duration.Input = "5 seconds"): Effect.Effect<A, E> {
	return Effect.gen(function* () {
		let iterations = 0;
		while (fiber.pollUnsafe() === undefined && iterations < 200) {
			yield* Effect.yieldNow;
			yield* Effect.yieldNow;
			yield* TestClock.adjust(step);
			iterations += 1;
		}
		return yield* Fiber.join(fiber);
	});
}

function eventError(event: AgentEvent | undefined): Error {
	expect(event).toMatchObject({ type: "error" });
	return (event as { error: Error }).error;
}

/**
 * Side-effect tool that records start/end markers around a real sleep. The
 * resource key (when given) is what the scheduler uses to decide conflicts.
 */
function slowEditTool(
	name: string,
	key: string | undefined,
	order: string[],
	duration: Duration.Input = "40 millis",
): Tool {
	return fakeTool({
		name,
		readonly: false,
		...(key !== undefined ? { resourceKey: () => key } : {}),
		execute: () =>
			Effect.gen(function* () {
				order.push(`start:${name}`);
				yield* Effect.sleep(duration);
				order.push(`end:${name}`);
				return { content: name };
			}),
	});
}

describe("agent loop", () => {
	it("retries a retryable provider error with backoff, then succeeds", async () => {
		const provider = new ScriptedProvider([
			fail(providerError("429 Too Many Requests", true)),
			chunks(textChunk("Hello"), doneChunk()),
		]);

		const events = await runTest(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(collect(run([USER_MESSAGE], config(provider))));
				return yield* joinDrivingClock(fiber);
			}),
		);

		expect(provider.requests).toHaveLength(2);
		expect(events.map((event) => event.type)).toEqual(["text_delta", "message_complete", "turn_complete"]);
	});

	it("does not retry a non-retryable provider error", async () => {
		const provider = new ScriptedProvider([fail(providerError("400 Bad Request", false))]);
		const events = await runTest(collect(run([USER_MESSAGE], config(provider))));

		expect(provider.requests).toHaveLength(1);
		expect(events).toHaveLength(1);
		expect(eventError(events[0]).message).toContain("400 Bad Request");
	});

	it("times out a stalled stream, retries, and gives up after the retry budget", async () => {
		const provider = new ScriptedProvider([hang(), hang(), hang()]);

		const events = await runTest(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(collect(run([USER_MESSAGE], config(provider))));
				return yield* joinDrivingClock(fiber);
			}),
		);

		expect(provider.requests).toHaveLength(3);
		expect(events).toHaveLength(1);
		expect(eventError(events[0]).message).toContain("Stream timeout");
	});

	it("injects a system note when the model repeats the same tool calls", async () => {
		const repeated = () =>
			chunks(toolCallsChunk([{ id: "call-1", name: "read_file", args: '{"path":"a.txt"}' }]), doneChunk());
		const provider = new ScriptedProvider([
			repeated(),
			repeated(),
			repeated(),
			repeated(),
			chunks(textChunk("done"), doneChunk()),
		]);
		let executions = 0;
		const read = fakeTool({
			name: "read_file",
			readonly: true,
			execute: () =>
				Effect.sync(() => {
					executions += 1;
					return { content: "file contents" };
				}),
		});

		const events = await runTest(collect(run([USER_MESSAGE], config(provider, [read]))));

		expect(executions).toBe(4);
		expect(events.at(-1)).toMatchObject({ type: "turn_complete" });
		const noteSeen = provider.requests.some((request) =>
			request.messages.some((message) => message.content?.includes("repeated the same tool calls 3 times")),
		);
		expect(noteSeen).toBe(true);
	});

	it("runs readonly tools in parallel before exclusive side-effect tools", async () => {
		const order: string[] = [];
		const readOne = fakeTool({
			name: "read_one",
			readonly: true,
			execute: () =>
				Effect.gen(function* () {
					order.push("start:read_one");
					yield* Effect.sleep("30 millis");
					order.push("end:read_one");
					return { content: "one" };
				}),
		});
		const readTwo = fakeTool({
			name: "read_two",
			readonly: true,
			execute: () =>
				Effect.gen(function* () {
					order.push("start:read_two");
					yield* Effect.sleep("30 millis");
					order.push("end:read_two");
					return { content: "two" };
				}),
		});
		// No resourceKey: exclusive, so it runs alone after the readonly phase.
		const write = fakeTool({
			name: "write_one",
			readonly: false,
			execute: () =>
				Effect.gen(function* () {
					order.push("start:write_one");
					yield* Effect.sleep("5 millis");
					order.push("end:write_one");
					return { content: "written" };
				}),
		});
		const provider = new ScriptedProvider([
			chunks(
				toolCallsChunk([
					{ id: "call-1", name: "read_one", args: "{}" },
					{ id: "call-2", name: "read_two", args: "{}" },
					{ id: "call-3", name: "write_one", args: "{}" },
				]),
				doneChunk(),
			),
			chunks(doneChunk()),
		]);

		// Live clock: the tool sleeps are real (milliseconds), no virtual time here.
		await Effect.runPromise(collect(run([USER_MESSAGE], config(provider, [readOne, readTwo, write]))));

		expect(order).toHaveLength(6);
		expect(order.indexOf("start:read_one")).toBeLessThan(order.indexOf("end:read_one"));
		expect(order.indexOf("start:read_two")).toBeLessThan(order.indexOf("end:read_two"));
		// Both readonly tools start before either finishes (parallel execution).
		expect(order.indexOf("start:read_two")).toBeLessThan(order.indexOf("end:read_one"));
		// The side-effect tool only starts after both readonly tools ended.
		expect(order.indexOf("end:read_one")).toBeLessThan(order.indexOf("start:write_one"));
		expect(order.indexOf("end:read_two")).toBeLessThan(order.indexOf("start:write_one"));
	});

	it("runs side-effect tools for different resources in parallel", async () => {
		const order: string[] = [];
		const editA = slowEditTool("edit_a", "file:a", order);
		const editB = slowEditTool("edit_b", "file:b", order);
		const provider = new ScriptedProvider([
			chunks(
				toolCallsChunk([
					{ id: "call-1", name: "edit_a", args: "{}" },
					{ id: "call-2", name: "edit_b", args: "{}" },
				]),
				doneChunk(),
			),
			chunks(doneChunk()),
		]);

		const events = await Effect.runPromise(collect(run([USER_MESSAGE], config(provider, [editA, editB]))));

		// Distinct keys: the second edit starts before the first one ends.
		expect(order.indexOf("start:edit_b")).toBeLessThan(order.indexOf("end:edit_a"));
		// Results are still emitted in call order.
		const results = events.filter((event) => event.type === "tool_result");
		expect(results.map((event) => event.id)).toEqual(["call-1", "call-2"]);
	});

	it("serializes side-effect tools that share a resource key", async () => {
		const order: string[] = [];
		const editA = slowEditTool("edit_a", "file:same", order, "20 millis");
		const editB = slowEditTool("edit_b", "file:same", order, "20 millis");
		const provider = new ScriptedProvider([
			chunks(
				toolCallsChunk([
					{ id: "call-1", name: "edit_a", args: "{}" },
					{ id: "call-2", name: "edit_b", args: "{}" },
				]),
				doneChunk(),
			),
			chunks(doneChunk()),
		]);

		await Effect.runPromise(collect(run([USER_MESSAGE], config(provider, [editA, editB]))));

		expect(order).toEqual(["start:edit_a", "end:edit_a", "start:edit_b", "end:edit_b"]);
	});

	it("treats a tool without a resource key as an ordering barrier", async () => {
		const order: string[] = [];
		const editA = slowEditTool("edit_a", "file:a", order);
		const shell = slowEditTool("shell", undefined, order);
		const editB = slowEditTool("edit_b", "file:b", order);
		const provider = new ScriptedProvider([
			chunks(
				toolCallsChunk([
					{ id: "call-1", name: "edit_a", args: "{}" },
					{ id: "call-2", name: "shell", args: "{}" },
					{ id: "call-3", name: "edit_b", args: "{}" },
				]),
				doneChunk(),
			),
			chunks(doneChunk()),
		]);

		await Effect.runPromise(collect(run([USER_MESSAGE], config(provider, [editA, shell, editB]))));

		// The exclusive call waits for everything before it and blocks everything after it.
		expect(order.indexOf("end:edit_a")).toBeLessThan(order.indexOf("start:shell"));
		expect(order.indexOf("end:shell")).toBeLessThan(order.indexOf("start:edit_b"));
	});

	it("overlaps independent edits that precede an exclusive tool", async () => {
		const order: string[] = [];
		const editA = slowEditTool("edit_a", "file:a", order);
		const editC = slowEditTool("edit_c", "file:c", order);
		const shell = slowEditTool("shell", undefined, order);
		const provider = new ScriptedProvider([
			chunks(
				toolCallsChunk([
					{ id: "call-1", name: "edit_a", args: "{}" },
					{ id: "call-2", name: "edit_c", args: "{}" },
					{ id: "call-3", name: "shell", args: "{}" },
				]),
				doneChunk(),
			),
			chunks(doneChunk()),
		]);

		await Effect.runPromise(collect(run([USER_MESSAGE], config(provider, [editA, editC, shell]))));

		// The two edits overlap; the shell call runs after both.
		expect(order.indexOf("start:edit_c")).toBeLessThan(order.indexOf("end:edit_a"));
		expect(order.indexOf("end:edit_a")).toBeLessThan(order.indexOf("start:shell"));
		expect(order.indexOf("end:edit_c")).toBeLessThan(order.indexOf("start:shell"));
	});

	it("suggests only tools present in the registry in execution hints", async () => {
		const failingRead = fakeTool({
			name: "read_file",
			readonly: true,
			execute: () => Effect.die(new Error("ENOENT: no such file or directory")),
		});
		const bash = fakeTool({ name: "bash", readonly: false, execute: () => Effect.succeed({ content: "" }) });
		const script = () =>
			new ScriptedProvider([
				chunks(toolCallsChunk([{ id: "call-1", name: "read_file", args: "{}" }]), doneChunk()),
				chunks(doneChunk()),
			]);

		const content = (events: AgentEvent[]): string => {
			const event = events.find((candidate) => candidate.type === "tool_result");
			return event && event.type === "tool_result" ? event.result.content : "";
		};

		const withoutBash = await Effect.runPromise(collect(run([USER_MESSAGE], config(script(), [failingRead]))));
		const withBash = await Effect.runPromise(collect(run([USER_MESSAGE], config(script(), [failingRead, bash]))));

		expect(content(withoutBash)).toContain("Use grep to locate");
		expect(content(withoutBash)).not.toContain("bash");
		expect(content(withBash)).toContain("Use grep or bash");
	});

	it("stops with an error after exceeding the maximum tool rounds", async () => {
		const loop = () => chunks(toolCallsChunk([{ id: "call-1", name: "read_file", args: "{}" }]), doneChunk());
		const provider = new ScriptedProvider([loop(), loop()]);
		const read = fakeTool({
			name: "read_file",
			readonly: true,
			execute: () => Effect.succeed({ content: "x" }),
		});

		const events = await runTest(collect(run([USER_MESSAGE], config(provider, [read], { maxToolRounds: 2 }))));

		expect(eventError(events.at(-1)).message).toContain("Exceeded maximum tool rounds");
	});
});
