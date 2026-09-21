import { assertEquals } from "@std/assert";
import type { CompletionRequest, LLMProvider, StreamChunk, Usage } from "@/api/types.ts";
import type { AgentEvent } from "@/core/agent.ts";
import { run } from "@/core/agent.ts";
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

function finishChunk(usage?: Usage): StreamChunk {
	return makeChunk({
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		...(usage && { usage }),
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
			readonly: name.startsWith("read"),
			execute,
		};
		registry.set(name, tool);
	}
	return registry;
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of gen) {
		events.push(event);
	}
	return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("text-only response yields text_delta and message_complete", async () => {
	const provider = mockProvider([[textChunk("Hello"), finishChunk()]]);
	const events = await collect(run(
		[{ role: "user", content: "Hi" }],
		{ provider, tools: new Map(), model: "test", systemPrompt: "You are helpful." },
	));

	assertEquals(events.length, 3);
	assertEquals(events[0], { type: "text_delta", content: "Hello" });
	assertEquals(events[1]!.type, "message_complete");
	assertEquals(events[2]!.type, "turn_complete");
});

Deno.test("accumulates multiple text deltas", async () => {
	const provider = mockProvider([[textChunk("Hel"), textChunk("lo"), finishChunk()]]);
	const events = await collect(run(
		[{ role: "user", content: "Hi" }],
		{ provider, tools: new Map(), model: "test", systemPrompt: "You are helpful." },
	));

	const textDeltas = events.filter((e) => e.type === "text_delta");
	assertEquals(textDeltas.length, 2);
	assertEquals((textDeltas[0] as { type: "text_delta"; content: string }).content, "Hel");
	assertEquals((textDeltas[1] as { type: "text_delta"; content: string }).content, "lo");
});

Deno.test("tool call executes and yields tool events", async () => {
	const provider = mockProvider([
		[toolCallChunk(0, "tc1", "echo", '{"text":"hi"}'), finishChunk()],
		[textChunk("Done"), finishChunk()],
	]);
	const tools = mockTools({
		echo: async (input: unknown) => {
			await Promise.resolve();
			return { content: (input as { text: string }).text };
		},
	});

	const events = await collect(run(
		[{ role: "user", content: "echo hi" }],
		{ provider, tools, model: "test", systemPrompt: "You are helpful." },
	));

	const types = events.map((e) => e.type);
	assertEquals(types.includes("tool_call_start"), true);
	assertEquals(types.includes("tool_call_args_delta"), true);
	assertEquals(types.includes("tool_call_end"), true);
	assertEquals(types.includes("tool_result"), true);

	const toolResult = events.find((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>;
	assertEquals(toolResult.result.content, "hi");

	const lastTextDelta = events.filter((e) => e.type === "text_delta").pop() as
		| Extract<AgentEvent, { type: "text_delta" }>
		| undefined;
	assertEquals(lastTextDelta?.content, "Done");
});

Deno.test("unknown tool returns error result", async () => {
	const provider = mockProvider([
		[toolCallChunk(0, "tc1", "nonexistent", "{}"), finishChunk()],
		[textChunk("OK"), finishChunk()],
	]);

	const events = await collect(run(
		[{ role: "user", content: "do something" }],
		{ provider, tools: new Map(), model: "test", systemPrompt: "You are helpful." },
	));

	const toolResult = events.find((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>;
	assertEquals(toolResult.result.isError, true);
	assertEquals(toolResult.result.content.includes("Unknown tool"), true);
});

Deno.test("invalid JSON args returns error result", async () => {
	const provider = mockProvider([
		[toolCallChunk(0, "tc1", "echo", "not json"), finishChunk()],
		[textChunk("OK"), finishChunk()],
	]);
	const tools = mockTools({
		echo: async (_input: unknown) => {
			await Promise.resolve();
			return { content: "ok" };
		},
	});

	const events = await collect(run(
		[{ role: "user", content: "do something" }],
		{ provider, tools, model: "test", systemPrompt: "You are helpful." },
	));

	const toolResult = events.find((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>;
	assertEquals(toolResult.result.isError, true);
	assertEquals(toolResult.result.content.includes("could not be parsed as JSON"), true);
});

Deno.test("max tool rounds exceeded yields error", async () => {
	const provider = mockProvider([
		[toolCallChunk(0, "tc1", "echo", '{"text":"a"}'), finishChunk()],
		[toolCallChunk(0, "tc2", "echo", '{"text":"b"}'), finishChunk()],
	]);
	const tools = mockTools({
		echo: async (input: unknown) => {
			await Promise.resolve();
			return { content: (input as { text: string }).text };
		},
	});

	const events = await collect(run(
		[{ role: "user", content: "loop" }],
		{ provider, tools, model: "test", systemPrompt: "You are helpful.", maxToolRounds: 1 },
	));

	const lastEvent = events[events.length - 1]!;
	assertEquals(lastEvent.type, "error");
	assertEquals(
		(lastEvent as Extract<AgentEvent, { type: "error" }>).error.message.includes("Exceeded maximum tool rounds"),
		true,
	);
});

Deno.test("message_complete includes usage and generationId", async () => {
	const usage: Usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
	const provider = mockProvider([[
		makeChunk({ id: "gen-abc", choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] }),
		makeChunk({ id: "gen-abc", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }),
	]]);

	const events = await collect(run(
		[{ role: "user", content: "Hi" }],
		{ provider, tools: new Map(), model: "test", systemPrompt: "You are helpful." },
	));

	const complete = events.find((e) => e.type === "message_complete") as Extract<
		AgentEvent,
		{ type: "message_complete" }
	>;
	assertEquals(complete.usage, usage);
	assertEquals(complete.generationId, "gen-abc");
});

Deno.test("stream error yields error event", async () => {
	const provider: LLMProvider = {
		complete() {
			throw new Error("not implemented");
		},
		async *stream(_request: CompletionRequest) {
			yield makeChunk({});
			throw new Error("400 Bad Request");
		},
	};

	const events = await collect(run(
		[{ role: "user", content: "Hi" }],
		{ provider, tools: new Map(), model: "test", systemPrompt: "You are helpful." },
	));

	const errorEvent = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }>;
	assertEquals(errorEvent.type, "error");
	assertEquals(errorEvent.error.message.includes("400 Bad Request"), true);
});
