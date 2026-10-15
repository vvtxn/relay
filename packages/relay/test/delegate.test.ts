// Behavior tests for the `delegate` subagent tool: isolated nested runs,
// read-only tool access, reports, failures, cost accounting, and the
// concurrency cap. The nested loop runs on the live clock.

import { describe, expect, it } from "vite-plus/test";
import { Effect, Stream } from "effect";
import type { CompletionRequest, LLMProvider, StreamChunk } from "../api/types.ts";
import { ProviderError } from "../api/errors.ts";
import { createDelegateTool } from "../core/tools/delegate.ts";
import { createToolRegistry, type Tool } from "../core/tools/types.ts";
import {
	chunks,
	doneChunk,
	fail,
	fakeTool,
	providerError,
	ScriptedProvider,
	textChunk,
	toolCallsChunk,
	usageChunk,
} from "./helpers.ts";

function delegate(
	provider: LLMProvider,
	tools: Tool[] = [],
	overrides: Partial<Parameters<typeof createDelegateTool>[0]> = {},
) {
	return createDelegateTool({
		provider,
		model: "fake-model",
		systemPrompt: "You are a test agent.",
		tools: createToolRegistry(tools),
		...overrides,
	});
}

describe("delegate tool", () => {
	it("runs an isolated subagent loop and returns its final report", async () => {
		const provider = new ScriptedProvider([chunks(textChunk("Found "), textChunk("it"), doneChunk())]);
		const tool = delegate(provider);

		const result = await Effect.runPromise(tool.execute({ prompt: "investigate the parser" }));

		expect(tool.readonly).toBe(true);
		expect(result.isError).not.toBe(true);
		expect(result.content).toBe("Found it");
		expect(result.meta?.durationMs).toBeTypeOf("number");
		// The subagent gets a fresh conversation: a system message with the
		// delegation instructions plus the prompt, and none of the caller's history.
		const request = provider.requests[0];
		expect(request?.messages[0]).toMatchObject({ role: "system" });
		expect(request?.messages[0]?.content).toContain("subagent");
		expect(request?.messages[1]).toMatchObject({ role: "user", content: "investigate the parser" });
	});

	it("uses the read-only tools it was given", async () => {
		let reads = 0;
		const read = fakeTool({
			name: "read_file",
			readonly: true,
			execute: () =>
				Effect.sync(() => {
					reads += 1;
					return { content: "file contents" };
				}),
		});
		const provider = new ScriptedProvider([
			chunks(toolCallsChunk([{ id: "call-1", name: "read_file", args: '{"path":"a.ts"}' }]), doneChunk()),
			chunks(textChunk("report"), doneChunk()),
		]);
		const tool = delegate(provider, [read]);

		const result = await Effect.runPromise(tool.execute({ prompt: "look at a.ts" }));

		expect(reads).toBe(1);
		expect(result.content).toBe("report");
	});

	it("returns an error result when the subagent fails", async () => {
		const provider = new ScriptedProvider([fail(providerError("model exploded", false))]);
		const tool = delegate(provider);

		const result = await Effect.runPromise(tool.execute({ prompt: "investigate" }));

		expect(result.isError).toBe(true);
		expect(result.content).toContain("Delegation failed");
		expect(result.content).toContain("model exploded");
	});

	it("rejects an empty prompt without starting a run", async () => {
		const provider = new ScriptedProvider([chunks(textChunk("nope"), doneChunk())]);
		const tool = delegate(provider);

		const result = await Effect.runPromise(tool.execute({ prompt: "   " }));

		expect(result.isError).toBe(true);
		expect(provider.requests).toHaveLength(0);
	});

	it("reports cancellation when the parent signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const provider = new ScriptedProvider([chunks(textChunk("late"), doneChunk())]);
		const tool = delegate(provider, [], { signal: controller.signal });

		const result = await Effect.runPromise(tool.execute({ prompt: "investigate" }));

		expect(result.isError).toBe(true);
		expect(result.content).toContain("cancelled");
		expect(provider.requests).toHaveLength(0);
	});

	it("accumulates subagent cost into the tool result", async () => {
		const provider = new ScriptedProvider([
			chunks(
				textChunk("report"),
				usageChunk({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.012 }),
			),
		]);
		const tool = delegate(provider);

		const result = await Effect.runPromise(tool.execute({ prompt: "investigate" }));

		expect(result.meta?.cost).toBe(0.012);
	});

	it("caps concurrent subagent loops", async () => {
		let active = 0;
		let peak = 0;
		const provider: LLMProvider = {
			async complete() {
				throw new Error("not implemented");
			},
			stream(_request: CompletionRequest): Stream.Stream<StreamChunk, ProviderError> {
				active += 1;
				peak = Math.max(peak, active);
				return Stream.concat(
					Stream.fromIterable<StreamChunk>([textChunk("report")]),
					Stream.fromEffect(Effect.sleep("30 millis")).pipe(Stream.map(() => doneChunk())),
				).pipe(Stream.ensuring(Effect.sync(() => void (active -= 1))));
			},
		};
		const tool = delegate(provider, [], { maxConcurrency: 1 });

		await Effect.runPromise(
			Effect.all([tool.execute({ prompt: "one" }), tool.execute({ prompt: "two" })], {
				concurrency: "unbounded",
			}),
		);

		expect(peak).toBe(1);
	});
});
