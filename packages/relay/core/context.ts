import type { Message } from "@/api/types.ts";

// ---------------------------------------------------------------------------
// Token estimation (heuristic: ~4 chars per token)
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD = 8;
const COMPLETION_HEADROOM = 16_000;

export const COMPLETION_TOKEN_LIMIT = 16_384;

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: Message): number {
	let tokens = MESSAGE_OVERHEAD;
	if (message.content) tokens += estimateTokens(message.content);
	if (message.name) tokens += estimateTokens(message.name);
	if (message.tool_calls) {
		for (const tc of message.tool_calls) {
			tokens += estimateTokens(tc.function.name) + estimateTokens(tc.function.arguments);
		}
	}
	return tokens;
}

// ---------------------------------------------------------------------------
// Turns — groups of messages that must be kept or dropped together
// ---------------------------------------------------------------------------

interface Turn {
	messages: Message[];
	tokens: number;
	droppable: boolean;
}

function groupIntoTurns(messages: Message[]): Turn[] {
	const turns: Turn[] = [];
	let i = 0;

	while (i < messages.length) {
		const msg = messages[i];
		if (!msg) break;

		if (msg.role === "system") {
			turns.push({ messages: [msg], tokens: estimateMessageTokens(msg), droppable: false });
			i++;
		} else if (msg.role === "user") {
			turns.push({ messages: [msg], tokens: estimateMessageTokens(msg), droppable: true });
			i++;
		} else if (msg.role === "assistant") {
			const group: Message[] = [msg];
			let groupTokens = estimateMessageTokens(msg);

			if (msg.tool_calls?.length) {
				let j = i + 1;
				while (j < messages.length) {
					const next = messages[j];
					if (!next || next.role !== "tool") break;
					group.push(next);
					groupTokens += estimateMessageTokens(next);
					j++;
				}
				i = j;
			} else {
				i++;
			}

			turns.push({ messages: group, tokens: groupTokens, droppable: true });
		} else {
			turns.push({ messages: [msg], tokens: estimateMessageTokens(msg), droppable: true });
			i++;
		}
	}

	const firstUserTurn = turns.find((t) => t.messages[0]?.role === "user");
	if (firstUserTurn) firstUserTurn.droppable = false;

	return turns;
}

// ---------------------------------------------------------------------------
// Semantic tool result summarization
// ---------------------------------------------------------------------------

function summarizeToolResult(content: string, toolName: string): string {
	if (content.startsWith("Failed") || content.startsWith("Error")) {
		return `failed: ${content.slice(0, 100)}`;
	}
	switch (toolName) {
		case "bash": {
			const firstLine = content.split("\n")[0] ?? "";
			if (firstLine === "(no output)") return "no output";
			if (/^exit code \d+/.test(firstLine)) return firstLine;
			return firstLine.slice(0, 120);
		}
		case "read_file": {
			if (content.startsWith("Failed")) return "failed to read";
			const lines = content.split("\n").length;
			return `read ${lines} lines`;
		}
		case "write_file":
		case "edit_file": {
			return content.split("\n")[0] ?? "";
		}
		case "grep": {
			if (content === "No matches found.") {
				return "no matches";
			}
			const lines = content.split("\n").filter((l) => l.trim());
			return `found ${lines.length} result${lines.length !== 1 ? "s" : ""}`;
		}
		default:
			return content.slice(0, 120);
	}
}

function turnToSummary(turn: Turn): Message {
	const parts: string[] = [];

	for (const msg of turn.messages) {
		if (msg.role === "user" && msg.content) {
			const preview = msg.content.slice(0, 200).replace(/\n/g, " ");
			parts.push(`User: ${preview}${msg.content.length > 200 ? "…" : ""}`);
		} else if (msg.role === "assistant") {
			if (msg.tool_calls?.length) {
				const names = msg.tool_calls.map((tc) => tc.function.name).join(", ");
				parts.push(`Called: ${names}`);
			}
			if (msg.content) {
				const preview = msg.content.slice(0, 100).replace(/\n/g, " ");
				parts.push(`Said: ${preview}${msg.content.length > 100 ? "…" : ""}`);
			}
		} else if (msg.role === "tool") {
			const summary = summarizeToolResult(msg.content || "", msg.name ?? "tool");
			parts.push(`→ ${summary}`);
		}
	}

	return {
		role: "user",
		content: `[previous turn]\n${parts.join("\n")}`,
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TrimOptions {
	/** Maximum token budget for the context. Default: 100_000 */
	maxTokens?: number;
	/** Number of recent turns to always keep intact (not summarized or dropped). Default: 6 */
	preserveRecentTurns?: number;
}

const DEFAULT_MAX_TOKENS = 100_000;
const DEFAULT_PRESERVE_RECENT_TURNS = 6;

/**
 * Trim a message array to fit within a token budget.
 *
 * Strategy (applied in order):
 * 1. If under budget → return as-is
 * 2. Summarize old turns into compact summary messages
 * 3. Drop oldest droppable turns until under budget
 */
export function trimContext(messages: Message[], options: TrimOptions = {}): Message[] {
	const budget = (options.maxTokens ?? DEFAULT_MAX_TOKENS) - COMPLETION_HEADROOM;
	const preserveRecent = options.preserveRecentTurns ?? DEFAULT_PRESERVE_RECENT_TURNS;

	const turns = groupIntoTurns(messages);
	let totalTokens = turns.reduce((sum, t) => sum + t.tokens, 0);

	if (totalTokens <= budget) return messages;

	// Phase 1: Summarize all droppable turns before the preserve boundary
	const recentStart = Math.max(0, turns.length - preserveRecent);
	for (let i = 0; i < recentStart; i++) {
		const turn = turns[i];
		if (!turn?.droppable) continue;
		const summary = turnToSummary(turn);
		const summaryTokens = estimateMessageTokens(summary);
		totalTokens += summaryTokens - turn.tokens;
		turns[i] = {
			messages: [summary],
			tokens: summaryTokens,
			droppable: turn.droppable,
		};
	}

	if (totalTokens <= budget) {
		return turns.flatMap((t) => t.messages);
	}

	// Phase 2: Drop oldest droppable turns
	const dropIndices = new Set<number>();
	for (let i = 0; i < recentStart && totalTokens > budget; i++) {
		const turn = turns[i];
		if (turn?.droppable) {
			totalTokens -= turn.tokens;
			dropIndices.add(i);
		}
	}

	return turns
		.filter((_, i) => !dropIndices.has(i))
		.flatMap((t) => t.messages);
}
