/**
 * Diff presentation helpers for the terminal client.
 *
 * Pure and UI-free so session collection can be tested without mounting the
 * TUI. `parseDiff`/`diffStats`/`buildDiffRows` come from the shared display
 * module, so the CLI and web read and flatten patches identically.
 */

import { diffStats, parseDiff, type UIMessage } from "@vvtxn/relay/core/display.ts";

/** One edit/write diff available for review in a session. */
export interface SessionDiff {
	/** Raw tool name (e.g. `edit_file`), used for its display label and accent. */
	name: string;
	/** File path from the patch header, falling back to the summarized tool arg. */
	path: string;
	diff: string;
	adds: number;
	deletes: number;
}

/** Collect every tool result that carried a diff, in conversation order. */
export function collectSessionDiffs(messages: UIMessage[]): SessionDiff[] {
	const diffs: SessionDiff[] = [];
	for (const message of messages) {
		for (const call of message.toolCalls ?? []) {
			if (!call.diff) continue;
			const parsed = parseDiff(call.diff);
			const stats = diffStats(call.diff);
			diffs.push({
				name: call.name,
				path: parsed[0]?.path ?? (call.input || "diff"),
				diff: call.diff,
				adds: stats.adds,
				deletes: stats.deletes,
			});
		}
	}
	return diffs;
}
