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
import { parseJson, postJson } from "../http.ts";
import {
	mapAnthropicStopReason,
	mapAnthropicUsage,
	parseAnthropicStream,
	type AnthropicUsage,
} from "../streaming/anthropic.ts";

const DEFAULT_MAX_TOKENS = 16_384;
const ANTHROPIC_VERSION = "2023-06-01";

// Wire types for the Anthropic Messages API. They stay private to this adapter.

interface AnthropicTextBlock {
	type: "text";
	text: string;
}

interface AnthropicToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: unknown;
}

interface AnthropicToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content: string;
	is_error?: boolean;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage {
	role: "user" | "assistant";
	content: string | AnthropicContentBlock[];
}

interface AnthropicTool {
	name: string;
	description: string;
	input_schema: ToolDefinition["parameters"];
}

interface AnthropicResponse {
	id?: string;
	content?: Array<{
		type?: string;
		text?: string;
		id?: string;
		name?: string;
		input?: unknown;
	}>;
	stop_reason?: string | null;
	usage?: AnthropicUsage;
}

/** Provider for the Anthropic Messages API (`/v1/messages`). */
export class AnthropicProvider implements LLMProvider {
	private readonly apiKey: string;
	private readonly baseURL: string;

	constructor(config: ProviderConfig) {
		this.apiKey = config.apiKey;
		this.baseURL = normalizeBaseURL(config.baseURL);
	}

	async complete(request: CompletionRequest): Promise<CompletionResult> {
		const body = this.buildBody(request, false);
		const response = await this.request(body, request.signal);
		const json = await parseJson<AnthropicResponse>(response);

		const textParts: string[] = [];
		const toolCalls: ToolCall[] = [];
		for (const block of json.content ?? []) {
			if (block.type === "text" && block.text) {
				textParts.push(block.text);
			} else if (block.type === "tool_use" && block.id && block.name) {
				toolCalls.push({
					id: block.id,
					name: block.name,
					arguments: JSON.stringify(block.input ?? {}),
				});
			}
		}

		const text = textParts.join("");
		return {
			id: json.id ?? "",
			message: {
				role: "assistant",
				content: text || null,
				...(toolCalls.length > 0 && { toolCalls }),
			},
			reason: mapAnthropicStopReason(json.stop_reason),
			...(json.usage ? { usage: mapAnthropicUsage(json.usage) } : {}),
		};
	}

	stream(request: CompletionRequest): Stream.Stream<LLMStreamEvent, ProviderError> {
		const body = this.buildBody(request, true);
		return Stream.unwrap(
			Effect.tryPromise({
				try: () => this.request(body, request.signal),
				catch: toProviderError,
			}).pipe(
				Effect.map((response) => Stream.fromAsyncIterable(parseAnthropicStream(response), toProviderError)),
			),
		);
	}

	private buildBody(request: CompletionRequest, stream: boolean): Record<string, unknown> {
		const system = request.messages
			.filter((message) => message.role === "system" && message.content)
			.map((message) => message.content)
			.join("\n\n");

		const messages = toAnthropicMessages(request.messages);
		const tools = request.tools?.length ? request.tools.map(toAnthropicTool) : undefined;

		return {
			model: request.model,
			...(system ? { system } : {}),
			messages,
			...(tools ? { tools } : {}),
			...(tools && request.toolChoice ? { tool_choice: toAnthropicToolChoice(request.toolChoice) } : {}),
			...(request.temperature !== undefined && { temperature: request.temperature }),
			max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
			stream,
		};
	}

	private request(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
		return postJson(`${this.baseURL}/messages`, {
			headers: {
				"x-api-key": this.apiKey,
				"anthropic-version": ANTHROPIC_VERSION,
			},
			body,
			model: String(body.model),
			...(signal ? { signal } : {}),
		});
	}
}

function normalizeBaseURL(raw: string): string {
	let base = raw.replace(/\/+$/, "").replace(/\/messages$/, "");
	try {
		const url = new URL(base);
		if (url.hostname === "api.anthropic.com" && (url.pathname === "" || url.pathname === "/")) {
			base = `${base}/v1`;
		}
	} catch {
		// Leave malformed URLs untouched; the fetch call reports the failure.
	}
	return base;
}

function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
	const result: AnthropicMessage[] = [];
	let expectedToolCallIds = new Set<string>();

	const flushMissingToolResults = (): void => {
		if (expectedToolCallIds.size === 0) return;
		const blocks: AnthropicToolResultBlock[] = [...expectedToolCallIds].map((id) => ({
			type: "tool_result",
			tool_use_id: id,
			content: "No result provided",
			is_error: true,
		}));
		expectedToolCallIds = new Set();
		appendToolResults(result, blocks);
	};

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (!message || message.role === "system") continue;

		if (message.role === "user") {
			flushMissingToolResults();
			const content = message.content?.trim();
			if (content) result.push({ role: "user", content });
			continue;
		}

		if (message.role === "assistant") {
			flushMissingToolResults();
			const blocks: AnthropicContentBlock[] = [];
			const text = message.content?.trim();
			if (text) blocks.push({ type: "text", text });

			const toolCalls = message.toolCalls ?? [];
			for (const toolCall of toolCalls) {
				blocks.push({
					type: "tool_use",
					id: sanitizeToolCallId(toolCall.id),
					name: toolCall.name,
					input: parseToolArguments(toolCall.arguments),
				});
			}

			if (blocks.length > 0) result.push({ role: "assistant", content: blocks });
			expectedToolCallIds = new Set(toolCalls.map((toolCall) => sanitizeToolCallId(toolCall.id)));
			continue;
		}

		// Tool results: group consecutive results into one user message, then
		// synthesize any calls the assistant made without a matching result.
		const blocks: AnthropicToolResultBlock[] = [];
		while (i < messages.length && messages[i]?.role === "tool") {
			const toolMessage = messages[i];
			if (toolMessage) {
				const id = toolMessage.toolCallId ? sanitizeToolCallId(toolMessage.toolCallId) : "";
				if (id && expectedToolCallIds.has(id)) {
					expectedToolCallIds.delete(id);
					blocks.push({
						type: "tool_result",
						tool_use_id: id,
						content: toolMessage.content ?? "",
					});
				}
			}
			i++;
		}
		i--;

		for (const id of expectedToolCallIds) {
			blocks.push({
				type: "tool_result",
				tool_use_id: id,
				content: "No result provided",
				is_error: true,
			});
		}
		expectedToolCallIds = new Set();
		appendToolResults(result, blocks);
	}

	flushMissingToolResults();
	return result;
}

function appendToolResults(messages: AnthropicMessage[], blocks: AnthropicToolResultBlock[]): void {
	if (blocks.length === 0) return;
	const previous = messages[messages.length - 1];
	if (previous?.role === "user" && Array.isArray(previous.content)) {
		messages[messages.length - 1] = { role: "user", content: [...previous.content, ...blocks] };
		return;
	}
	messages.push({ role: "user", content: blocks });
}

function toAnthropicTool(tool: ToolDefinition): AnthropicTool {
	return {
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters,
	};
}

function toAnthropicToolChoice(choice: ToolChoice): Record<string, string> {
	if (choice === "auto" || choice === "none") return { type: choice };
	return { type: "tool", name: choice.name };
}

function sanitizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function parseToolArguments(args: string): Record<string, unknown> {
	if (!args.trim()) return {};
	try {
		const parsed = JSON.parse(args) as unknown;
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}
