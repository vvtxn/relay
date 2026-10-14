// OpenAI-compatible types for /v1/chat/completions
// Works with any provider exposing an OpenAI-compatible API (open-source models, KimiK2, etc.)

import type { Stream } from "effect";
import type { ProviderError } from "./errors.ts";

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type Role = "system" | "user" | "assistant" | "tool";

export type FinishReason = "stop" | "tool_calls" | "length" | null;

export interface ToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string; // JSON-serialized
	};
}

export interface Message {
	role: Role;
	content: string | null;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
	name?: string;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface ToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: JsonSchema;
	};
}

export type ToolChoice = "auto" | "none" | { type: "function"; function: { name: string } };

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
	tool_choice?: ToolChoice;
	temperature?: number;
	max_tokens?: number;
	stream?: boolean;
	signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Response (non-streaming)
// ---------------------------------------------------------------------------

export interface Usage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	cost?: number;
}

export interface CompletionChoice {
	index: number;
	message: Message;
	finish_reason: FinishReason;
}

export interface CompletionResponse {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: CompletionChoice[];
	usage?: Usage;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export interface DeltaToolCall {
	index: number;
	id?: string;
	type?: "function";
	function?: {
		name?: string;
		arguments?: string;
	};
}

export interface Delta {
	role?: Role;
	content?: string | null;
	tool_calls?: DeltaToolCall[];
}

export interface StreamChoice {
	index: number;
	delta: Delta;
	finish_reason: FinishReason;
}

export interface StreamChunk {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: StreamChoice[];
	usage?: Usage;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ProviderConfig {
	apiKey: string;
	baseURL: string;
}

export interface LLMProvider {
	complete(request: CompletionRequest): Promise<CompletionResponse>;
	stream(request: CompletionRequest): Stream.Stream<StreamChunk, ProviderError>;
}
