import type { UIMessage, UIToolCall } from "@vvtxn/relay/core/display.ts";

/** One transcript row: a prose turn or a collapsed bundle of tool calls. */
export type TranscriptBlock =
	| { kind: "message"; start: number; msg: UIMessage }
	| { kind: "tools"; start: number; calls: UIToolCall[] };

/**
 * Merged tool-call arrays for multi-turn tool runs. Keyed by the run's first
 * `toolCalls` array (not the `UIMessage` wrapper, which `viewMessages()`
 * recreates on every render for the active draft) so in-flight runs keep array
 * identity across text deltas and spinner ticks. Single-turn runs reuse
 * `msg.toolCalls` directly with no allocation.
 */
const runCache = new WeakMap<UIToolCall[], { sources: UIToolCall[][]; calls: UIToolCall[] }>();

/**
 * Fold the transcript into render rows. Every message's prose becomes a
 * `message` block, and its tool calls join a `tools` run placed immediately
 * after it; a run keeps absorbing calls from following tool-only turns, so
 * `read` → `read` → `write` renders as one collapsible `2 reads · 1 write` row.
 * User turns and prose-bearing turns end a run (their own calls start a new
 * one), and empty agent turns are skipped without splitting it.
 *
 * Call arrays keep identity across commits while a run is unchanged, which
 * lets memoized rows skip streamed deltas.
 */
export function bundleTranscript(messages: UIMessage[]): TranscriptBlock[] {
	const blocks: TranscriptBlock[] = [];
	let runSources: UIToolCall[][] = [];
	let runStart = -1;

	const flushRun = () => {
		if (runSources.length === 0) return;
		const first = runSources[0]!;
		let calls: UIToolCall[];
		if (runSources.length === 1) {
			calls = first;
		} else {
			const cached = runCache.get(first);
			if (
				cached &&
				cached.sources.length === runSources.length &&
				cached.sources.every((source, i) => source === runSources[i])
			) {
				calls = cached.calls;
			} else {
				calls = runSources.flat();
				runCache.set(first, { sources: runSources, calls });
			}
		}
		blocks.push({ kind: "tools", start: runStart, calls });
		runSources = [];
		runStart = -1;
	};

	for (let index = 0; index < messages.length; index++) {
		const msg = messages[index];
		if (!msg) continue;

		// User and system turns (e.g. a model-switch notice) are standalone rows:
		// they always break a tool run, even when their content is empty.
		if (msg.role === "user" || msg.role === "system") {
			flushRun();
			blocks.push({ kind: "message", start: index, msg });
			continue;
		}

		const hasText = msg.content.trim() !== "";
		const toolCalls = msg.toolCalls;

		if (hasText) {
			flushRun();
			blocks.push({ kind: "message", start: index, msg });
		}
		// No calls: prose-only already flushed the run above; an empty turn
		// renders nothing and must not split one.
		if (!toolCalls || toolCalls.length === 0) continue;
		if (runSources.length === 0) runStart = index;
		runSources.push(toolCalls);
	}

	flushRun();
	return blocks;
}
