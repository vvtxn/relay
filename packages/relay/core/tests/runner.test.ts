import { assertEquals } from "@std/assert";
import type { CompletionRequest, LLMProvider, StreamChunk } from "@/api/types.ts";
import { runAgentLoop } from "@/core/runner.ts";
import type { Tool, ToolRegistry, ToolResult } from "@/core/tools/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockProvider(responses: StreamChunk[][]): LLMProvider {
	let callCount = 0;
	return {
		complete(_request: CompletionRequest) {
			throw new Error("not implemented");
		},
		async *stream(_request: CompletionRequest) {
			const chunks = responses[callCount++] ?? [];
			for (const chunk of chunks) {
				yield chunk;
			}
		},
	};
}

function makeChunk(overrides: Partial<StreamChunk> = {}): StreamChunk {
	return {
		id: "gen-1",
		object: "chat.completion.chunk",
		created: 0,
		model: "test",
		choices: [],
		...overrides,
	};
}

function textChunk(content: string): StreamChunk {
	return makeChunk({
		choices: [{ index: 0, delta: { content }, finish_reason: null }],
	});
}

function toolCallChunk(index: number, id: string, name: string, args: string): StreamChunk {
	return makeChunk({
		choices: [{
			index: 0,
			delta: {
				tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }],
			},
			finish_reason: null,
		}],
	});
}

// Continuation delta for a tool call: providers send id/name only on the first chunk.
function toolCallArgsChunk(index: number, args: string): StreamChunk {
	return makeChunk({
		choices: [{
			index: 0,
			delta: {
				tool_calls: [{ index, type: "function", function: { arguments: args } }],
			},
			finish_reason: null,
		}],
	});
}

function finishChunk(): StreamChunk {
	return makeChunk({
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	});
}

function mockTools(tools: Record<string, (input: unknown) => Promise<ToolResult>>): ToolRegistry {
	const registry: ToolRegistry = new Map();
	for (const [name, execute] of Object.entries(tools)) {
		const tool: Tool = {
			definition: {
				type: "function",
				function: {
					name,
					description: `Mock tool ${name}`,
					parameters: { type: "object" },
				},
			},
			execute,
		};
		registry.set(name, tool);
	}
	return registry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("streams tool call start and args deltas in order", async () => {
	const provider = mockProvider([
		[
			toolCallChunk(0, "tc1", "echo", '{"tex'),
			toolCallArgsChunk(0, 't":"h'),
			toolCallArgsChunk(0, 'i"}'),
			finishChunk(),
		],
		[textChunk("Done"), finishChunk()],
	]);
	const tools = mockTools({
		echo: (input: unknown) => Promise.resolve({ content: (input as { text: string }).text }),
	});

	const events: string[] = [];
	const argsDeltas: string[] = [];
	let endArgs = "";

	await runAgentLoop(
		[{ role: "user", content: "echo hi" }],
		{ provider, tools, model: "test", systemPrompt: "You are helpful." },
		{
			onTextDelta(delta) {
				events.push(`text:${delta}`);
			},
			onToolCallStart(id, name) {
				events.push(`start:${id}:${name}`);
			},
			onToolCallArgsDelta(id, args) {
				events.push(`args:${id}:${args}`);
				argsDeltas.push(args);
			},
			onToolCallEnd(id, _name, args) {
				events.push(`end:${id}`);
				endArgs = args;
			},
			onToolResult(id, result) {
				events.push(`result:${id}:${result.content}`);
			},
			onMessageComplete() {
				events.push("message_complete");
			},
			onTurnComplete() {
				events.push("turn_complete");
			},
			onError(error) {
				events.push(`error:${error.message}`);
			},
		},
	);

	assertEquals(events, [
		"start:tc1:echo",
		'args:tc1:{"tex',
		'args:tc1:t":"h',
		'args:tc1:i"}',
		"end:tc1",
		"message_complete",
		"result:tc1:hi",
		"turn_complete",
		"text:Done",
		"message_complete",
		"turn_complete",
	]);
	assertEquals(endArgs, '{"text":"hi"}');
});

Deno.test("required callbacks still work without optional streaming callbacks", async () => {
	const provider = mockProvider([
		[toolCallChunk(0, "tc1", "echo", '{"text":"hi"}'), finishChunk()],
		[textChunk("Done"), finishChunk()],
	]);
	const tools = mockTools({
		echo: (input: unknown) => Promise.resolve({ content: (input as { text: string }).text }),
	});

	let endName = "";
	let endArgs = "";

	await runAgentLoop(
		[{ role: "user", content: "echo hi" }],
		{ provider, tools, model: "test", systemPrompt: "You are helpful." },
		{
			onTextDelta() {},
			onToolCallEnd(_id, name, args) {
				endName = name;
				endArgs = args;
			},
			onToolResult() {},
			onMessageComplete() {},
			onTurnComplete() {},
			onError() {},
		},
	);

	assertEquals(endName, "echo");
	assertEquals(endArgs, '{"text":"hi"}');
});

Deno.test("routes callback failures to onError without abandoning the stream", async () => {
	const provider = mockProvider([[textChunk("one"), textChunk("two"), finishChunk()]]);
	const errors: string[] = [];
	const text: string[] = [];

	await runAgentLoop(
		[{ role: "user", content: "hello" }],
		{ provider, tools: new Map(), model: "test", systemPrompt: "You are helpful." },
		{
			onTextDelta(delta) {
				text.push(delta);
				if (delta === "one") throw new Error("display failed");
			},
			onToolCallEnd() {},
			onToolResult() {},
			onMessageComplete() {},
			onTurnComplete() {},
			onError(error) {
				errors.push(error.message);
			},
		},
	);

	assertEquals(text, ["one", "two"]);
	assertEquals(errors, ["display failed"]);
});

Deno.test("stops dispatching events after the abort signal fires", async () => {
	const provider = mockProvider([[textChunk("one"), textChunk("two"), finishChunk()]]);
	const controller = new AbortController();
	const text: string[] = [];

	await runAgentLoop(
		[{ role: "user", content: "hello" }],
		{ provider, tools: new Map(), model: "test", systemPrompt: "You are helpful.", signal: controller.signal },
		{
			onTextDelta(delta) {
				text.push(delta);
				controller.abort();
			},
			onToolCallEnd() {},
			onToolResult() {},
			onMessageComplete() {},
			onTurnComplete() {},
			onError() {},
		},
	);

	assertEquals(text, ["one"]);
});
