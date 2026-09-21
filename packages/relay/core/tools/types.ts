import type { JsonSchema, ToolDefinition } from "@/api/types.ts";

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
	};
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export interface Tool {
	definition: ToolDefinition;
	readonly?: boolean;
	execute(input: unknown): Promise<ToolResult>;
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

export function defineTool(opts: {
	name: string;
	description: string;
	parameters: JsonSchema;
	readonly?: boolean;
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
		execute: opts.execute,
	};
}
