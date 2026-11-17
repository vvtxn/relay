import type { UIMessage, UIToolCall } from "@vvtxn/relay/core/display.ts";

/** One transcript row: a prose turn or a collapsed bundle of tool calls. */
export type TranscriptBlock =
	| { kind: "message"; start: number; msg: UIMessage }
	| { kind: "tools"; start: number; calls: UIToolCall[] };

/**
 * Cached tool-call arrays for a run of tool activity. Keyed by the run's first
 * source message and guarded by element identity so a replaced draft turn
 * invalidates the entry instead of reusing stale calls.
 */
const runCache = new WeakMap<UIMessage, { sources: UIMessage[]; calls: UIToolCall[] }>();

/** One-entry cache for the whole list: idle commits keep the same `messages` array. */
let cachedMessages: UIMessage[] | null = null;
let cachedBlocks: TranscriptBlock[] = [];

/**
 * Fold the transcript into render rows. Every message's prose becomes a
 * `message` block, and its tool calls join a `tools` run placed immediately
 * after it; a run keeps absorbing calls from following tool-only turns, so
 * `read` → `read` → `write` renders as one collapsible `2 reads · 1 write` row.
 * User turns and prose-bearing turns end a run (their own calls start a new
 * one), and empty agent turns are skipped without splitting it.
 *
 * Call arrays keep identity across commits while a run is unchanged (see
 * `runCache`), which lets memoized rows skip streamed deltas.
 */
export function bundleTranscript(messages: UIMessage[]): TranscriptBlock[] {
	if (messages === cachedMessages) return cachedBlocks;

	const blocks: TranscriptBlock[] = [];
	let runSources: UIMessage[] = [];
	let runStart = -1;

	const flushRun = () => {
		if (runSources.length === 0) return;
		const first = runSources[0]!;
		const cached = runCache.get(first);
		let calls: UIToolCall[];
		if (
			cached &&
			cached.sources.length === runSources.length &&
			cached.sources.every((source, i) => source === runSources[i])
		) {
			calls = cached.calls;
		} else {
			calls = runSources.flatMap((message) => message.toolCalls ?? []);
			runCache.set(first, { sources: runSources, calls });
		}
		blocks.push({ kind: "tools", start: runStart, calls });
		runSources = [];
		runStart = -1;
	};

	for (let index = 0; index < messages.length; index++) {
		const msg = messages[index];
		if (!msg) continue;

		if (msg.role === "user") {
			flushRun();
			blocks.push({ kind: "message", start: index, msg });
			continue;
		}

		const hasText = msg.content.trim() !== "";
		const toolCalls = msg.toolCalls ?? [];

		if (hasText) {
			flushRun();
			blocks.push({ kind: "message", start: index, msg });
		}
		// No calls: prose-only already flushed the run above; an empty turn
		// renders nothing and must not split one.
		if (toolCalls.length === 0) continue;
		if (runSources.length === 0) runStart = index;
		runSources.push(msg);
	}

	flushRun();

	cachedMessages = messages;
	cachedBlocks = blocks;
	return blocks;
}
