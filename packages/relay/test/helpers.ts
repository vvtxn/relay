// TEMP(effect-migration): shared fakes for the phase-0 agent-loop
// characterization tests. Remove after phase 3 — see docs/effect-migration.md.

import type { CompletionRequest, CompletionResponse, LLMProvider, StreamChunk, Usage } from "../api/types.ts";
import type { Tool, ToolResult } from "../core/tools/types.ts";

// ---------------------------------------------------------------------------
// Scripted LLM provider
// ---------------------------------------------------------------------------

/** One response for one `stream()` call, in order. */
export type StreamScript = (request: CompletionRequest) => AsyncIterable<StreamChunk>;

export class ScriptedProvider implements LLMProvider {
	readonly requests: CompletionRequest[] = [];
	private readonly scripts: StreamScript[];

	constructor(scripts: StreamScript[]) {
		this.scripts = [...scripts];
	}

	async complete(): Promise<CompletionResponse> {
		throw new Error("ScriptedProvider.complete is not implemented");
	}

	stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
		this.requests.push(request);
		const script = this.scripts.shift();
		if (!script) throw new Error("ScriptedProvider: no script left for this request");
		return script(request);
	}
}

// -- chunk builders ---------------------------------------------------------

const CHUNK_BASE = { id: "gen-1", object: "chat.completion.chunk", created: 0, model: "fake-model" } as const;

export function textChunk(content: string): StreamChunk {
	return { ...CHUNK_BASE, choices: [{ index: 0, delta: { content }, finish_reason: null }] };
}

export function usageChunk(usage: Usage): StreamChunk {
	return { ...CHUNK_BASE, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage };
}

export function doneChunk(): StreamChunk {
	return { ...CHUNK_BASE, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
}

/** One chunk carrying any number of tool calls in a single assistant message. */
export function toolCallsChunk(calls: Array<{ id: string; name: string; args: string }>): StreamChunk {
	return {
		...CHUNK_BASE,
		choices: [
			{
				index: 0,
				delta: {
					tool_calls: calls.map((call, index) => ({
						index,
						id: call.id,
						function: { name: call.name, arguments: call.args },
					})),
				},
				finish_reason: null,
			},
		],
	};
}

// -- scripts ----------------------------------------------------------------

export function chunks(...items: StreamChunk[]): StreamScript {
	return () =>
		(async function* () {
			for (const item of items) yield item;
		})();
}

function iterableOf(next: () => Promise<IteratorResult<StreamChunk>>): AsyncIterable<StreamChunk> {
	return { [Symbol.asyncIterator]: () => ({ next }) };
}

export function fail(error: Error): StreamScript {
	return () => iterableOf(() => Promise.reject(error));
}

/** Never yields; models a stalled stream. */
export function hang(): StreamScript {
	return () => iterableOf(() => new Promise<IteratorResult<StreamChunk>>(() => {}));
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function fakeTool(options: {
	name: string;
	readonly: boolean;
	execute: (input: unknown) => Promise<ToolResult>;
}): Tool {
	return {
		definition: {
			type: "function",
			function: { name: options.name, description: options.name, parameters: { type: "object" } },
		},
		readonly: options.readonly,
		execute: options.execute,
	};
}
