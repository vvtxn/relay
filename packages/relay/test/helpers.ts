// Shared fakes for the agent-loop tests: a scripted `Stream` provider and
// lightweight tools.

import { Effect, Stream } from "effect";
import { ProviderError } from "../api/errors.ts";
import type { CompletionRequest, CompletionResponse, LLMProvider, StreamChunk, Usage } from "../api/types.ts";
import type { Tool, ToolResult } from "../core/tools/types.ts";

// ---------------------------------------------------------------------------
// Scripted LLM provider
// ---------------------------------------------------------------------------

/** One response for one `stream()` call, in order. */
export type StreamScript = () => Stream.Stream<StreamChunk, ProviderError>;

export class ScriptedProvider implements LLMProvider {
	readonly requests: CompletionRequest[] = [];
	private readonly scripts: StreamScript[];

	constructor(scripts: StreamScript[]) {
		this.scripts = [...scripts];
	}

	async complete(): Promise<CompletionResponse> {
		throw new Error("ScriptedProvider.complete is not implemented");
	}

	stream(request: CompletionRequest): Stream.Stream<StreamChunk, ProviderError> {
		this.requests.push(request);
		const script = this.scripts.shift();
		if (!script) {
			return Stream.fail(new ProviderError({ message: "ScriptedProvider: no script left", retryable: false }));
		}
		return script();
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

export function providerError(message: string, retryable: boolean): ProviderError {
	return new ProviderError({ message, retryable });
}

export function chunks(...items: StreamChunk[]): StreamScript {
	return () => Stream.fromIterable(items);
}

export function fail(error: ProviderError): StreamScript {
	return () => Stream.fail(error);
}

/** Never yields; models a stalled stream. */
export function hang(): StreamScript {
	return () => Stream.never;
}

/** Yields the given chunks, then hangs (never completes). */
export function chunksThenHang(...items: StreamChunk[]): StreamScript {
	return () => Stream.concat(Stream.fromIterable(items), Stream.never);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function fakeTool(options: {
	name: string;
	readonly: boolean;
	execute: (input: unknown) => Effect.Effect<ToolResult>;
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
