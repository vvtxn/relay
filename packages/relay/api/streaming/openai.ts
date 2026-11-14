import type { FinishReason, LLMStreamEvent, Usage } from "#/api/types.ts";
import { ProviderError } from "../errors.ts";
import { parseSSE } from "./sse.ts";

// Wire types for the OpenAI-compatible /chat/completions streaming format.
// They are exported only for the OpenAI provider adapter; the rest of the
// codebase sees the provider-neutral types in api/types.ts.

export interface OpenAIUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	/** OpenRouter reports the request cost inside the usage object. */
	cost?: number;
}

interface OpenAIStreamToolCall {
	index?: number;
	id?: string;
	function?: {
		name?: string;
		arguments?: string;
	};
}

interface OpenAIStreamChunk {
	id?: string;
	choices?: Array<{
		delta?: {
			content?: string | null;
			tool_calls?: OpenAIStreamToolCall[];
		};
		finish_reason?: string | null;
	}>;
	usage?: OpenAIUsage;
	error?: { message?: string; type?: string };
}

interface PendingToolCall {
	id?: string;
	name?: string;
	args: string;
	started: boolean;
	sawArguments: boolean;
}

/** Translates an OpenAI-compatible SSE response into provider-neutral events. */
export async function* parseOpenAIStream(response: Response): AsyncIterable<LLMStreamEvent> {
	let id = "";
	let reason: FinishReason = null;
	let usage: Usage | undefined;
	const pending = new Map<number, PendingToolCall>();

	for await (const event of parseSSE(response)) {
		if (event.data === "[DONE]") break;
		if (event.data.trim() === "") continue;

		let chunk: OpenAIStreamChunk;
		try {
			chunk = JSON.parse(event.data) as OpenAIStreamChunk;
		} catch {
			// Compatible providers occasionally emit non-JSON keepalive frames.
			continue;
		}

		if (chunk.error) {
			throw new ProviderError({
				message: chunk.error.message ?? "OpenAI-compatible provider stream error",
				retryable: true,
			});
		}

		if (chunk.id) id = chunk.id;
		if (chunk.usage) usage = mapOpenAIUsage(chunk.usage);

		for (const choice of chunk.choices ?? []) {
			const delta = choice.delta;
			if (!delta) continue;

			if (delta.content) {
				yield { type: "text_delta", text: delta.content };
			}

			for (const tc of delta.tool_calls ?? []) {
				const index = tc.index ?? 0;
				let entry = pending.get(index);
				if (!entry) {
					entry = { args: "", started: false, sawArguments: false };
					pending.set(index, entry);
				}

				if (tc.id) entry.id = tc.id;
				if (tc.function?.name) entry.name = tc.function.name;

				const args = tc.function?.arguments;
				if (args) {
					entry.sawArguments = true;
					if (entry.started) yield { type: "tool_call_args_delta", index, args };
					else entry.args += args;
				}

				if (!entry.started && entry.id && entry.name) {
					entry.started = true;
					yield { type: "tool_call_start", index, id: entry.id, name: entry.name };
					if (entry.args) {
						yield { type: "tool_call_args_delta", index, args: entry.args };
						entry.args = "";
					}
				}
			}

			const finish = mapOpenAIFinishReason(choice.finish_reason);
			if (finish !== null) reason = finish;
		}
	}

	// Some compatible providers send the tool name/id only after argument
	// fragments; flush anything that completed before the stream ended.
	for (const [index, entry] of pending) {
		if (!entry.started) {
			if (!entry.name) continue;
			entry.started = true;
			yield { type: "tool_call_start", index, id: entry.id ?? "", name: entry.name };
			if (entry.args) yield { type: "tool_call_args_delta", index, args: entry.args };
		}
		// Tool calls without arguments still need valid JSON (`{}`) for the
		// agent's executor.
		if (!entry.sawArguments) yield { type: "tool_call_args_delta", index, args: "{}" };
	}

	yield { type: "finish", id, reason, ...(usage ? { usage } : {}) };
}

export function mapOpenAIUsage(usage: OpenAIUsage): Usage {
	const inputTokens = usage.prompt_tokens ?? 0;
	const outputTokens = usage.completion_tokens ?? 0;
	return {
		inputTokens,
		outputTokens,
		totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
		...(typeof usage.cost === "number" ? { cost: usage.cost } : {}),
	};
}

export function mapOpenAIFinishReason(reason: string | null | undefined): FinishReason {
	switch (reason) {
		case "stop":
			return "stop";
		case "length":
			return "length";
		case "tool_calls":
		case "function_call":
			return "tool_calls";
		case "content_filter":
			return "content_filter";
		default:
			return null;
	}
}
