// Provider-neutral LLM types used by the agent loop, sessions, and tools.
// Wire formats (OpenAI chat/completions, Anthropic messages) live in the
// provider adapters under ./providers and are translated at that boundary.

import type { Stream } from "effect";
import type { ProviderError } from "./errors.ts";

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type Role = "system" | "user" | "assistant" | "tool";

export type FinishReason = "stop" | "tool_calls" | "length" | "content_filter" | null;

export interface ToolCall {
	id: string;
	name: string;
	/** JSON-serialized arguments, as accumulated from the model stream. */
	arguments: string;
}

export interface Message {
	role: Role;
	content: string | null;
	/** Assistant tool calls, in the order the model emitted them. */
	toolCalls?: ToolCall[];
	/** Tool-result messages: the id of the call being answered. */
	toolCallId?: string;
	/** Tool-result messages: the tool name (some providers use it for context). */
	name?: string;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: JsonSchema;
}

export type ToolChoice = "auto" | "none" | { name: string };

/** JSON Schema subset used for tool parameter definitions. */
export type JsonSchema = {
	type?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	description?: string;
	items?: JsonSchema;
	enum?: unknown[];
	[key: string]: unknown;
};

export interface CompletionRequest {
	model: string;
	messages: Message[];
	tools?: ToolDefinition[];
	toolChoice?: ToolChoice;
	temperature?: number;
	maxTokens?: number;
	/**
	 * Stable id for the conversation. Gateways that route or cache prompt
	 * prefixes per session (OpenCode Go, for example) receive it in the header
	 * named by `ProviderConfig.sessionHeader`.
	 */
	sessionId?: string;
	signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Usage / responses
// ---------------------------------------------------------------------------

export interface Usage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cost?: number;
}

export interface CompletionResult {
	id: string;
	message: Message;
	reason: FinishReason;
	usage?: Usage;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * Provider-neutral stream events. Every adapter translates its wire format
 * into this sequence; the agent loop is the only consumer.
 */
export type LLMStreamEvent =
	| { type: "text_delta"; text: string }
	| { type: "tool_call_start"; index: number; id: string; name: string }
	| { type: "tool_call_args_delta"; index: number; args: string }
	| { type: "finish"; id: string; reason: FinishReason; usage?: Usage };

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export type ProviderKind = "openai" | "anthropic";

export interface ProviderConfig {
	apiKey: string;
	baseURL: string;
	/** OpenAI wire format; `responses` targets the Responses API. */
	api?: "chat-completions" | "responses";
	/** How the adapter presents the credential. Defaults to the adapter's native style. */
	authStyle?: "x-api-key" | "bearer";
	/** Extra static headers merged into every request (preset-provided). */
	headers?: Record<string, string>;
	/**
	 * Header that carries the request's `sessionId`, when the endpoint needs a
	 * stable conversation id. Presets opt in; adapters stay gateway-agnostic.
	 */
	sessionHeader?: string;
}

export interface LLMProvider {
	complete(request: CompletionRequest): Promise<CompletionResult>;
	stream(request: CompletionRequest): Stream.Stream<LLMStreamEvent, ProviderError>;
}
