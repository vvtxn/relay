import type { ToolCall } from "#/api/types.ts";
import type { Entry } from "./types.ts";

/**
 * Reads session entries written by older Relay versions. The previous tool
 * call shape embedded the OpenAI wire format (`{ id, type, function: {...} }`);
 * the current one is provider-neutral (`{ id, name, arguments }`). New entries
 * are always written in the neutral shape.
 */
export function normalizeEntry(entry: Entry): Entry {
	if (entry.type !== "message" || !entry.toolCalls) return entry;

	const toolCalls = normalizeToolCalls(entry.toolCalls);
	if (!toolCalls) {
		const { toolCalls: _ignored, ...rest } = entry;
		return rest;
	}
	return { ...entry, toolCalls };
}

function normalizeToolCalls(raw: unknown): ToolCall[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const toolCalls: ToolCall[] = [];
	for (const value of raw) {
		const toolCall = normalizeToolCall(value);
		if (toolCall) toolCalls.push(toolCall);
	}
	return toolCalls.length > 0 ? toolCalls : undefined;
}

function normalizeToolCall(raw: unknown): ToolCall | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const value = raw as Record<string, unknown>;
	const fn = value.function;
	const legacy = typeof fn === "object" && fn !== null ? (fn as Record<string, unknown>) : undefined;

	const id = typeof value.id === "string" ? value.id : "";
	const name = typeof value.name === "string" ? value.name : typeof legacy?.name === "string" ? legacy.name : "";
	if (!name) return undefined;

	const args =
		typeof value.arguments === "string"
			? value.arguments
			: typeof legacy?.arguments === "string"
				? legacy.arguments
				: "{}";

	return { id, name, arguments: args };
}
