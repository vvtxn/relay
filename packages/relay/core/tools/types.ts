import { Data, Effect } from "effect";
import type { JsonSchema, ToolDefinition } from "#/api/types.ts";

// ---------------------------------------------------------------------------
// Tool result
// ---------------------------------------------------------------------------

export interface ToolResult {
	content: string;
	isError?: boolean;
	meta?: {
		truncated?: boolean;
		durationMs?: number;
		/** Unified diff output from file-editing tools */
		diff?: string;
		/** Cost accumulated by nested agent work (the `delegate` tool) */
		cost?: number;
	};
}

/** Typed failure from a tool; the agent loop enriches it into a `ToolResult`. */
export class ToolError extends Data.TaggedError("ToolError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** Normalizes a thrown value into a `ToolError`. */
export function toToolError(error: unknown): ToolError {
	return new ToolError({
		message: error instanceof Error ? error.message : String(error),
		cause: error,
	});
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export interface Tool {
	definition: ToolDefinition;
	readonly?: boolean;
	/**
	 * Resource key for dependency-aware execution of side-effect tools: two
	 * calls with the same key never run at the same time, and calls without a
	 * key (e.g. bash) are exclusive — they never overlap any other side-effect
	 * call. Ignored for readonly tools.
	 */
	resourceKey?: (input: unknown) => string | undefined;
	execute(input: unknown): Effect.Effect<ToolResult, ToolError>;
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

export type ToolRegistry = Map<string, Tool>;

export function createToolRegistry(tools: Tool[]): ToolRegistry {
	const registry: ToolRegistry = new Map();
	for (const tool of tools) {
		registry.set(tool.definition.function.name, tool);
	}
	return registry;
}

export function getDefinitions(registry: ToolRegistry): ToolDefinition[] {
	return Array.from(registry.values()).map((t) => t.definition);
}

// ---------------------------------------------------------------------------
// Helper to define a tool with less boilerplate
// ---------------------------------------------------------------------------

/**
 * Tools are authored as async functions (their bodies are promise-based IO:
 * fs, child processes). `defineTool` lifts them into the Effect-based `Tool`
 * interface; unexpected throws surface as a typed `ToolError`.
 */
export function defineTool(opts: {
	name: string;
	description: string;
	parameters: JsonSchema;
	readonly?: boolean;
	resourceKey?: (input: unknown) => string | undefined;
	execute: (input: unknown) => Promise<ToolResult>;
}): Tool {
	return {
		definition: {
			type: "function",
			function: {
				name: opts.name,
				description: opts.description,
				parameters: opts.parameters,
			},
		},
		...(opts.readonly !== undefined ? { readonly: opts.readonly } : {}),
		...(opts.resourceKey !== undefined ? { resourceKey: opts.resourceKey } : {}),
		execute: (input) =>
			Effect.tryPromise({
				try: () => opts.execute(input),
				catch: toToolError,
			}),
	};
}
