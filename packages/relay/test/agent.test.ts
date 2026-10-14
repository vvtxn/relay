// TEMP(effect-migration): characterization tests for the agent-loop rewrite
// (phase 3, provider/agent as Stream + Schedule). Remove after phase 3 — see
// docs/effect-migration.md ("Testing strategy").

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { type AgentConfig, type AgentEvent, run } from "../core/agent.ts";
import { createToolRegistry, type Tool } from "../core/tools/types.ts";
import { chunks, doneChunk, fail, fakeTool, hang, ScriptedProvider, textChunk, toolCallsChunk } from "./helpers.ts";

const USER_MESSAGE = { role: "user", content: "hello" } as const;

function config(provider: ScriptedProvider, tools: Tool[] = [], overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		provider,
		tools: createToolRegistry(tools),
		model: "fake-model",
		systemPrompt: "You are a test agent.",
		...overrides,
	};
}

async function collect(iterator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of iterator) events.push(event);
	return events;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("agent loop", () => {
	it("retries a retryable provider error with backoff, then succeeds", async () => {
		vi.useFakeTimers();
		const provider = new ScriptedProvider([
			fail(new Error("429 Too Many Requests")),
			chunks(textChunk("Hello"), doneChunk()),
		]);

		const events: AgentEvent[] = [];
		const done = (async () => {
			for await (const event of run([USER_MESSAGE], config(provider))) events.push(event);
		})();

		await vi.advanceTimersByTimeAsync(1000);
		await done;

		expect(provider.requests).toHaveLength(2);
		expect(events.map((event) => event.type)).toEqual(["text_delta", "message_complete", "turn_complete"]);
	});

	it("does not retry a non-retryable provider error", async () => {
		const provider = new ScriptedProvider([fail(new Error("400 Bad Request"))]);
		const events = await collect(run([USER_MESSAGE], config(provider)));

		expect(provider.requests).toHaveLength(1);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "error" });
		expect((events[0] as { error: Error }).error.message).toContain("400 Bad Request");
	});

	it("times out a stalled stream, retries, and gives up after the retry budget", async () => {
		vi.useFakeTimers();
		const provider = new ScriptedProvider([hang(), hang(), hang()]);

		const events: AgentEvent[] = [];
		const done = (async () => {
			for await (const event of run([USER_MESSAGE], config(provider))) events.push(event);
		})();

		await vi.advanceTimersByTimeAsync(60_000); // attempt 0 times out
		await vi.advanceTimersByTimeAsync(1_000); // backoff after attempt 0
		await vi.advanceTimersByTimeAsync(60_000); // attempt 1 times out
		await vi.advanceTimersByTimeAsync(2_000); // backoff after attempt 1
		await vi.advanceTimersByTimeAsync(60_000); // attempt 2 times out
		await done;

		expect(provider.requests).toHaveLength(3);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "error" });
		expect((events[0] as { error: Error }).error.message).toContain("Stream timeout");
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
			execute: async () => {
				executions += 1;
				return { content: "file contents" };
			},
		});

		const events = await collect(run([USER_MESSAGE], config(provider, [read])));

		expect(executions).toBe(4);
		expect(events.at(-1)).toMatchObject({ type: "turn_complete" });
		const noteSeen = provider.requests.some((request) =>
			request.messages.some((message) => message.content?.includes("repeated the same tool calls 3 times")),
		);
		expect(noteSeen).toBe(true);
	});

	it("runs readonly tools in parallel and side-effect tools sequentially afterwards", async () => {
		const order: string[] = [];
		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		const readOne = fakeTool({
			name: "read_one",
			readonly: true,
			execute: async () => {
				order.push("start:read_one");
				await sleep(30);
				order.push("end:read_one");
				return { content: "one" };
			},
		});
		const readTwo = fakeTool({
			name: "read_two",
			readonly: true,
			execute: async () => {
				order.push("start:read_two");
				await sleep(30);
				order.push("end:read_two");
				return { content: "two" };
			},
		});
		const write = fakeTool({
			name: "write_one",
			readonly: false,
			execute: async () => {
				order.push("start:write_one");
				await sleep(5);
				order.push("end:write_one");
				return { content: "written" };
			},
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

		await collect(run([USER_MESSAGE], config(provider, [readOne, readTwo, write])));

		expect(order).toHaveLength(6);
		expect(order.indexOf("start:read_one")).toBeLessThan(order.indexOf("end:read_one"));
		expect(order.indexOf("start:read_two")).toBeLessThan(order.indexOf("end:read_two"));
		// Both readonly tools start before either finishes (parallel execution).
		expect(order.indexOf("start:read_two")).toBeLessThan(order.indexOf("end:read_one"));
		// The side-effect tool only starts after both readonly tools ended.
		expect(order.indexOf("end:read_one")).toBeLessThan(order.indexOf("start:write_one"));
		expect(order.indexOf("end:read_two")).toBeLessThan(order.indexOf("start:write_one"));
	});

	it("stops with an error after exceeding the maximum tool rounds", async () => {
		const loop = () => chunks(toolCallsChunk([{ id: "call-1", name: "read_file", args: "{}" }]), doneChunk());
		const provider = new ScriptedProvider([loop(), loop()]);
		const read = fakeTool({ name: "read_file", readonly: true, execute: async () => ({ content: "x" }) });

		const events = await collect(run([USER_MESSAGE], config(provider, [read], { maxToolRounds: 2 })));

		expect(events.at(-1)).toMatchObject({ type: "error" });
		expect((events.at(-1) as { error: Error }).error.message).toContain("Exceeded maximum tool rounds");
	});
});
