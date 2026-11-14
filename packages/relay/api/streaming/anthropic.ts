import type { FinishReason, LLMStreamEvent, Usage } from "#/api/types.ts";
import { ProviderError } from "../errors.ts";
import { parseSSE } from "./sse.ts";

// Wire types for the Anthropic Messages streaming API. They are exported only
// for the Anthropic provider adapter; the rest of the codebase sees the
// provider-neutral types in api/types.ts.

export interface AnthropicUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

interface AnthropicContentBlock {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	input?: unknown;
	[key: string]: unknown;
}

interface AnthropicStreamEvent {
	type: string;
	index?: number;
	message?: {
		id?: string;
		usage?: AnthropicUsage;
	};
	content_block?: AnthropicContentBlock;
	delta?: {
		type?: string;
		text?: string;
		partial_json?: string;
		thinking?: string;
		signature?: string;
		stop_reason?: string | null;
	};
	usage?: AnthropicUsage;
	error?: {
		type?: string;
		message?: string;
	};
}

interface OpenBlock {
	kind: "text" | "tool" | "other";
	tool?: {
		id: string;
		name: string;
		initial: unknown;
		args: string;
		emitted: boolean;
	};
}

interface UsageState {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	sawUsage: boolean;
}

/** Translates an Anthropic Messages SSE response into provider-neutral events. */
export async function* parseAnthropicStream(response: Response): AsyncIterable<LLMStreamEvent> {
	let id = "";
	let reason: FinishReason = null;
	let sawMessageStop = false;
	const usage: UsageState = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sawUsage: false };
	const blocks = new Map<number, OpenBlock>();

	for await (const sse of parseSSE(response)) {
		if (sse.event === "ping") continue;

		let event: AnthropicStreamEvent;
		try {
			event = JSON.parse(sse.data) as AnthropicStreamEvent;
		} catch {
			// Proxies occasionally forward comment/keepalive frames; tolerate
			// unnamed non-JSON data but fail named events loudly.
			if (!sse.event) continue;
			throw new ProviderError({
				message: `Malformed Anthropic stream event (${sse.event})`,
				retryable: true,
			});
		}

		switch (event.type) {
			case "message_start": {
				if (event.message?.id) id = event.message.id;
				updateUsage(usage, event.message?.usage);
				break;
			}

			case "content_block_start": {
				const index = event.index ?? 0;
				const block = event.content_block;
				if (!block) break;

				if (block.type === "text") {
					blocks.set(index, { kind: "text" });
					if (block.text) yield { type: "text_delta", text: block.text };
				} else if (block.type === "tool_use") {
					const toolId = block.id ?? "";
					const toolName = block.name ?? "";
					blocks.set(index, {
						kind: "tool",
						tool: {
							id: toolId,
							name: toolName,
							initial: block.input,
							args: "",
							emitted: false,
						},
					});
					yield { type: "tool_call_start", index, id: toolId, name: toolName };
				} else {
					// Thinking and other block types are not part of the text +
					// tool-call contract yet; keep the index reserved so deltas
					// are ignored rather than misattributed.
					blocks.set(index, { kind: "other" });
				}
				break;
			}

			case "content_block_delta": {
				const index = event.index ?? 0;
				const block = blocks.get(index);
				const delta = event.delta;
				if (!block || !delta) break;

				if (delta.type === "text_delta" && block.kind === "text" && delta.text) {
					yield { type: "text_delta", text: delta.text };
				} else if (delta.type === "input_json_delta" && block.kind === "tool" && block.tool) {
					if (delta.partial_json) {
						block.tool.args += delta.partial_json;
						block.tool.emitted = true;
						yield { type: "tool_call_args_delta", index, args: delta.partial_json };
					}
				}
				break;
			}

			case "content_block_stop": {
				const index = event.index ?? 0;
				const block = blocks.get(index);
				blocks.delete(index);

				// No-argument tools (and providers that send the full input in
				// content_block_start) have no input_json_delta at all. Emit the
				// complete JSON now so the agent never tries to parse "".
				if (block?.kind === "tool" && block.tool && !block.tool.emitted) {
					const args = JSON.stringify(block.tool.initial ?? {});
					yield { type: "tool_call_args_delta", index, args };
				}
				break;
			}

			case "message_delta": {
				const stopReason = event.delta?.stop_reason;
				if (stopReason) reason = mapAnthropicStopReason(stopReason);
				updateUsage(usage, event.usage);
				break;
			}

			case "message_stop": {
				sawMessageStop = true;
				break;
			}

			case "error": {
				const type = event.error?.type;
				const status = anthropicErrorStatus(type);
				throw new ProviderError({
					message: event.error?.message ?? "Anthropic provider stream error",
					...(status !== undefined ? { status } : {}),
					retryable: isRetryableAnthropicError(type),
				});
			}

			default:
				break;
		}
	}

	if (!sawMessageStop) {
		throw new ProviderError({
			message: "Anthropic stream ended before message_stop",
			retryable: true,
		});
	}

	const finalUsage = toUsage(usage);
	yield { type: "finish", id, reason, ...(finalUsage ? { usage: finalUsage } : {}) };
}

export function mapAnthropicStopReason(reason: string | null | undefined): FinishReason {
	switch (reason) {
		case "end_turn":
		case "stop_sequence":
		case "pause_turn":
			return "stop";
		case "max_tokens":
		case "model_context_window_exceeded":
			return "length";
		case "tool_use":
			return "tool_calls";
		case "refusal":
		case "sensitive":
			return "content_filter";
		default:
			return null;
	}
}

/** Anthropic reports cached input separately from `input_tokens`. */
export function mapAnthropicUsage(usage: AnthropicUsage): Usage {
	const cacheRead = usage.cache_read_input_tokens ?? 0;
	const cacheWrite = usage.cache_creation_input_tokens ?? 0;
	const inputTokens = (usage.input_tokens ?? 0) + cacheRead + cacheWrite;
	const outputTokens = usage.output_tokens ?? 0;
	return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function updateUsage(state: UsageState, usage: AnthropicUsage | undefined): void {
	if (!usage) return;
	state.sawUsage = true;
	if (usage.input_tokens !== undefined) state.input = usage.input_tokens;
	if (usage.output_tokens !== undefined) state.output = usage.output_tokens;
	if (usage.cache_read_input_tokens !== undefined) state.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens !== undefined) state.cacheWrite = usage.cache_creation_input_tokens;
}

function toUsage(state: UsageState): Usage | undefined {
	if (!state.sawUsage) return undefined;
	const inputTokens = state.input + state.cacheRead + state.cacheWrite;
	return { inputTokens, outputTokens: state.output, totalTokens: inputTokens + state.output };
}

function anthropicErrorStatus(type: string | undefined): number | undefined {
	switch (type) {
		case "authentication_error":
			return 401;
		case "permission_error":
			return 403;
		case "not_found_error":
			return 404;
		case "request_too_large":
			return 413;
		case "rate_limit_error":
			return 429;
		case "api_error":
			return 500;
		case "overloaded_error":
			return 529;
		default:
			return undefined;
	}
}

function isRetryableAnthropicError(type: string | undefined): boolean {
	return (
		type === "rate_limit_error" || type === "api_error" || type === "overloaded_error" || type === "timeout_error"
	);
}
