import { Effect, Stream } from "effect";
import type {
	CompletionRequest,
	CompletionResult,
	LLMProvider,
	LLMStreamEvent,
	Message,
	ProviderConfig,
	ToolChoice,
	ToolDefinition,
} from "#/api/types.ts";
import type { ProviderError } from "../errors.ts";
import { toProviderError } from "../errors.ts";
import { requestHeaders } from "../headers.ts";
import { FETCH_TIMEOUT_MS, parseJson, postJson } from "../http.ts";
import { mapOpenAIFinishReason, mapOpenAIUsage, parseOpenAIStream, type OpenAIUsage } from "../streaming/openai.ts";

export interface GenerationStats {
	totalCost: number | null;
	promptTokens: number | null;
	completionTokens: number | null;
}

const DEFAULT_MAX_TOKENS = 16_384;

// Wire types for the OpenAI-compatible /chat/completions API. They stay
// private to this adapter.

interface OpenAIToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

interface OpenAIMessage {
	role: string;
	content: string;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
	name?: string;
}

interface OpenAICompletionResponse {
	id?: string;
	choices?: Array<{
		message?: {
			content?: string | null;
			tool_calls?: OpenAIToolCall[];
		};
		finish_reason?: string | null;
	}>;
	usage?: OpenAIUsage;
}

/** Provider for any API implementing the OpenAI `/chat/completions` format. */
export class OpenAICompletionsProvider implements LLMProvider {
	private readonly apiKey: string;
	private readonly baseURL: string;
	private readonly headers: Record<string, string> | undefined;
	private readonly sessionHeader: string | undefined;

	constructor(config: ProviderConfig) {
		this.apiKey = config.apiKey;
		this.headers = config.headers;
		this.sessionHeader = config.sessionHeader;
		// Normalize: strip trailing slashes and /chat/completions if someone pastes the full endpoint URL
		this.baseURL = config.baseURL.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
	}

	async complete(request: CompletionRequest): Promise<CompletionResult> {
		const body = this.buildBody(request, false);
		const response = await this.request(body, request);
		const json = await parseJson<OpenAICompletionResponse>(response);
		const choice = json.choices?.[0];
		const rawMessage = choice?.message;
		const toolCalls =
			rawMessage?.tool_calls?.map((tc) => ({
				id: tc.id,
				name: tc.function.name,
				arguments: tc.function.arguments,
			})) ?? [];

		return {
			id: json.id ?? "",
			message: {
				role: "assistant",
				content: rawMessage?.content ?? null,
				...(toolCalls.length > 0 && { toolCalls }),
			},
			reason: mapOpenAIFinishReason(choice?.finish_reason),
			...(json.usage ? { usage: mapOpenAIUsage(json.usage) } : {}),
		};
	}

	stream(request: CompletionRequest): Stream.Stream<LLMStreamEvent, ProviderError> {
		const body = this.buildBody(request, true);
		return Stream.unwrap(
			Effect.tryPromise({
				try: () => this.request(body, request),
				catch: toProviderError,
			}).pipe(Effect.map((response) => Stream.fromAsyncIterable(parseOpenAIStream(response), toProviderError))),
		);
	}

	private buildBody(request: CompletionRequest, stream: boolean): Record<string, unknown> {
		return {
			model: request.model,
			messages: toOpenAIMessages(request.messages),
			stream,
			...(stream && { stream_options: { include_usage: true } }),
			...(request.tools?.length ? { tools: request.tools.map(toOpenAIToolDefinition) } : {}),
			...(request.toolChoice ? { tool_choice: toOpenAIToolChoice(request.toolChoice) } : {}),
			...(request.temperature !== undefined && { temperature: request.temperature }),
			max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
		};
	}

	/** Fetch generation stats from OpenRouter's generation endpoint. Returns null for non-OpenRouter providers. */
	async getGenerationStats(id: string): Promise<GenerationStats | null> {
		let timer: ReturnType<typeof setTimeout>;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("Generation stats request timed out")), FETCH_TIMEOUT_MS);
		});
		try {
			const url = `${this.baseURL}/generation?id=${encodeURIComponent(id)}`;
			const response = await Promise.race([
				fetch(url, { headers: { Authorization: `Bearer ${this.apiKey}` } }),
				timeout,
			]);
			if (!response.ok) return null;
			const json = (await response.json()) as {
				data?: { total_cost?: unknown; tokens_prompt?: unknown; tokens_completion?: unknown };
			};
			const data = json.data;
			if (!data) return null;
			return {
				totalCost: typeof data.total_cost === "number" ? data.total_cost : null,
				promptTokens: typeof data.tokens_prompt === "number" ? data.tokens_prompt : null,
				completionTokens: typeof data.tokens_completion === "number" ? data.tokens_completion : null,
			};
		} catch {
			return null;
		} finally {
			clearTimeout(timer!);
		}
	}

	private request(body: Record<string, unknown>, request: CompletionRequest): Promise<Response> {
		return postJson(`${this.baseURL}/chat/completions`, {
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

function toOpenAIMessages(messages: Message[]): OpenAIMessage[] {
	return messages.map((msg) => {
		if (msg.role === "assistant") {
			return {
				role: "assistant",
				content: msg.content ?? "",
				...(msg.toolCalls?.length
					? {
							tool_calls: msg.toolCalls.map((tc) => ({
								id: tc.id,
								type: "function" as const,
								function: { name: tc.name, arguments: tc.arguments },
							})),
						}
					: {}),
			};
		}

		if (msg.role === "tool") {
			return {
				role: "tool",
				content: msg.content ?? "",
				...(msg.toolCallId ? { tool_call_id: msg.toolCallId } : {}),
				...(msg.name ? { name: msg.name } : {}),
			};
		}

		return { role: msg.role, content: msg.content ?? "" };
	});
}

function toOpenAIToolDefinition(tool: ToolDefinition): Record<string, unknown> {
	return {
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	};
}

function toOpenAIToolChoice(choice: ToolChoice): unknown {
	if (choice === "auto" || choice === "none") return choice;
	return { type: "function", function: { name: choice.name } };
}
