import { Effect, Stream } from "effect";
import type {
	CompletionRequest,
	CompletionResult,
	LLMProvider,
	LLMStreamEvent,
	Message,
	ProviderConfig,
	ToolCall,
	ToolChoice,
	ToolDefinition,
} from "#/api/types.ts";
import type { ProviderError } from "../errors.ts";
import { toProviderError } from "../errors.ts";
import { requestHeaders } from "../headers.ts";
import { parseJson, postJson } from "../http.ts";
import { parseSSE } from "../streaming/sse.ts";

const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

// Wire types for the OpenAI Responses API (used by the ChatGPT/Codex
// subscription backend). They stay private to this adapter.

interface ResponsesTextContent {
	type?: string;
	text?: string;
}

interface ResponsesOutputItem {
	type?: string;
	id?: string;
	call_id?: string;
	name?: string;
	arguments?: string;
	content?: ResponsesTextContent[];
}

interface ResponsesUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
}

interface ResponsesResponse {
	id?: string;
	output?: ResponsesOutputItem[];
	usage?: ResponsesUsage;
	incomplete_details?: { reason?: string } | null;
	status?: string;
}

interface ResponsesStreamEvent {
	type?: string;
	delta?: string;
	item?: ResponsesOutputItem;
	item_id?: string;
	output_index?: number;
	response?: ResponsesResponse;
	error?: { message?: string; code?: string };
}

/** Provider for OpenAI's Responses API (`/responses`). */
export class OpenAIResponsesProvider implements LLMProvider {
	private readonly apiKey: string;
	private readonly baseURL: string;
	private readonly headers: Record<string, string> | undefined;
	private readonly sessionHeader: string | undefined;

	constructor(config: ProviderConfig) {
		this.apiKey = config.apiKey;
		this.headers = config.headers;
		this.sessionHeader = config.sessionHeader;
		this.baseURL = config.baseURL.replace(/\/+$/, "").replace(/\/responses$/, "");
	}

	async complete(request: CompletionRequest): Promise<CompletionResult> {
		const body = this.buildBody(request, false);
		const response = await this.request(body, request);
		const json = await parseJson<ResponsesResponse>(response);

		const textParts: string[] = [];
		const toolCalls: ToolCall[] = [];
		for (const item of json.output ?? []) {
			if (item.type === "message") {
				for (const part of item.content ?? []) {
					if (part.text) textParts.push(part.text);
				}
			} else if (item.type === "function_call" && item.name) {
				toolCalls.push({
					id: item.call_id ?? item.id ?? "",
					name: item.name,
					arguments: item.arguments ?? "{}",
				});
			}
		}

		return {
			id: json.id ?? "",
			message: {
				role: "assistant",
				content: textParts.join("") || null,
				...(toolCalls.length > 0 && { toolCalls }),
			},
			reason:
				json.incomplete_details?.reason === "max_output_tokens"
					? "length"
					: toolCalls.length > 0
						? "tool_calls"
						: "stop",
			...(json.usage ? { usage: mapResponsesUsage(json.usage) } : {}),
		};
	}

	stream(request: CompletionRequest): Stream.Stream<LLMStreamEvent, ProviderError> {
		const body = this.buildBody(request, true);
		return Stream.unwrap(
			Effect.tryPromise({
				try: () => this.request(body, request),
				catch: toProviderError,
			}).pipe(
				Effect.map((response) => Stream.fromAsyncIterable(parseResponsesStream(response), toProviderError)),
			),
		);
	}

	private buildBody(request: CompletionRequest, stream: boolean): Record<string, unknown> {
		const system = request.messages
			.filter((message) => message.role === "system" && message.content)
			.map((message) => message.content)
			.join("\n\n");
		const tools = request.tools?.length ? request.tools.map(toResponsesTool) : undefined;

		return {
			model: request.model,
			...(system ? { instructions: system } : {}),
			input: toResponsesInput(request.messages),
			...(tools ? { tools } : {}),
			...(tools && request.toolChoice ? { tool_choice: toResponsesToolChoice(request.toolChoice) } : {}),
			// ChatGPT/Codex reasoning models reject sampling parameters; the
			// subscription backend uses its own defaults.
			max_output_tokens: request.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
			stream,
			store: false,
			parallel_tool_calls: true,
		};
	}

	private request(body: Record<string, unknown>, request: CompletionRequest): Promise<Response> {
		return postJson(`${this.baseURL}/responses`, {
			headers: requestHeaders(
				{ Authorization: `Bearer ${this.apiKey}` },
				{
					headers: this.headers,
					sessionHeader: this.sessionHeader,
					sessionId: request.sessionId,
				},
			),
			body,
			model: String(body.model),
			...(request.signal ? { signal: request.signal } : {}),
		});
	}
}

function toResponsesInput(messages: Message[]): unknown[] {
	const input: unknown[] = [];
	for (const message of messages) {
		if (!message) continue;
		switch (message.role) {
			case "system":
				break;
			case "user":
				input.push({
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: message.content ?? "" }],
				});
				break;
			case "assistant": {
				if (message.content) {
					input.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: message.content }],
					});
				}
				for (const toolCall of message.toolCalls ?? []) {
					input.push({
						type: "function_call",
						call_id: toolCall.id,
						name: toolCall.name,
						arguments: toolCall.arguments,
					});
				}
				break;
			}
			case "tool":
				input.push({
					type: "function_call_output",
					call_id: message.toolCallId ?? "",
					output: message.content ?? "",
				});
				break;
		}
	}
	return input;
}

function toResponsesTool(tool: ToolDefinition): Record<string, unknown> {
	return {
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	};
}

function toResponsesToolChoice(choice: ToolChoice): unknown {
	if (choice === "auto" || choice === "none") return choice;
	return { type: "function", name: choice.name };
}

function mapResponsesUsage(usage: ResponsesUsage): {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
} {
	const inputTokens = usage.input_tokens ?? 0;
	const outputTokens = usage.output_tokens ?? 0;
	return {
		inputTokens,
		outputTokens,
		totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
	};
}

/**
 * Translates a Responses API SSE stream into provider-neutral events.
 *
 * Function calls arrive as `output_item.added` (name/id) followed by argument
 * deltas; text streams through `response.output_text.delta`; usage and the
 * final finish reason come from `response.completed`.
 */
export async function* parseResponsesStream(response: Response): AsyncIterable<LLMStreamEvent> {
	let id = "";
	let reason: "stop" | "tool_calls" | "length" = "stop";
	let usage: ReturnType<typeof mapResponsesUsage> | undefined;
	const calls = new Map<number, { id: string; name: string; sawArguments: boolean }>();
	const byItem = new Map<string, number>();
	const indexOf = (chunk: ResponsesStreamEvent): number =>
		chunk.output_index ?? (chunk.item_id ? (byItem.get(chunk.item_id) ?? 0) : 0);

	for await (const event of parseSSE(response)) {
		if (event.data.trim() === "" || event.data === "[DONE]") continue;
		let chunk: ResponsesStreamEvent;
		try {
			chunk = JSON.parse(event.data) as ResponsesStreamEvent;
		} catch {
			continue;
		}

		switch (chunk.type) {
			case "response.output_text.delta":
				if (typeof chunk.delta === "string" && chunk.delta.length > 0) {
					yield { type: "text_delta", text: chunk.delta };
				}
				break;
			case "response.output_item.added": {
				const item = chunk.item;
				if (!item || item.type !== "function_call") break;
				const index = chunk.output_index ?? calls.size;
				const callId = item.call_id ?? item.id ?? "";
				const name = item.name ?? "";
				if (!name) break;
				calls.set(index, { id: callId, name, sawArguments: false });
				if (item.id) byItem.set(item.id, index);
				reason = "tool_calls";
				yield { type: "tool_call_start", index, id: callId, name };
				if (item.arguments) {
					const entry = calls.get(index);
					if (entry) entry.sawArguments = true;
					yield { type: "tool_call_args_delta", index, args: item.arguments };
				}
				break;
			}
			case "response.function_call_arguments.delta": {
				const index = indexOf(chunk);
				const entry = calls.get(index);
				if (!entry) break;
				if (typeof chunk.delta === "string" && chunk.delta.length > 0) {
					entry.sawArguments = true;
					yield { type: "tool_call_args_delta", index, args: chunk.delta };
				}
				break;
			}
			case "response.output_item.done": {
				const item = chunk.item;
				if (!item || item.type !== "function_call") break;
				const index = indexOf(chunk);
				let entry = calls.get(index);
				// Recover calls whose name only appeared on the completed item.
				if (!entry && item.name) {
					entry = { id: item.call_id ?? item.id ?? "", name: item.name, sawArguments: false };
					calls.set(index, entry);
					reason = "tool_calls";
					yield { type: "tool_call_start", index, id: entry.id, name: entry.name };
				}
				if (entry && !entry.sawArguments && item.arguments) {
					entry.sawArguments = true;
					yield { type: "tool_call_args_delta", index, args: item.arguments };
				}
				break;
			}
			case "response.completed": {
				const completed = chunk.response;
				if (completed?.id) id = completed.id;
				if (completed?.usage) usage = mapResponsesUsage(completed.usage);
				if (completed?.incomplete_details?.reason === "max_output_tokens") reason = "length";
				break;
			}
			case "response.failed":
			case "error": {
				const message = chunk.error?.message ?? chunk.response?.status ?? "Responses provider stream error";
				throw new Error(message);
			}
		}
	}

	// Calls with no arguments still need valid JSON for the tool executor.
	for (const [index, entry] of calls) {
		if (!entry.sawArguments) yield { type: "tool_call_args_delta", index, args: "{}" };
	}

	yield { type: "finish", id, reason, ...(usage ? { usage } : {}) };
}
