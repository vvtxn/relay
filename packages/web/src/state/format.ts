import type { RunPhase, SessionSummary } from "@vvtxn/relay/core/sessions/index.ts";

/**
 * Display formatting shared by the overview and the thread lists. Pure and
 * signal-free so it can be used from any component without pulling in state.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function toDate(timestamp: number | string): Date | null {
	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** Compact "how long ago" label for thread and workspace rows. */
export function formatRelativeTime(timestamp: number | string, now = Date.now()): string {
	const date = toDate(timestamp);
	if (!date) return "";
	const diff = now - date.getTime();
	if (diff < 45_000) return "just now";
	if (diff < HOUR) return `${Math.max(1, Math.round(diff / MINUTE))}m ago`;
	if (diff < DAY) return `${Math.round(diff / HOUR)}h ago`;
	if (diff < 7 * DAY) return `${Math.round(diff / DAY)}d ago`;
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Full timestamp for `title` tooltips beside a relative label. */
export function formatExactTime(timestamp: number | string): string {
	const date = toDate(timestamp);
	return date ? date.toLocaleString() : "";
}

/** First user message, or a placeholder for a thread with no text yet. */
export function threadPreview(session: SessionSummary, limit = 0): string {
	const text = session.firstUserMessage || "(empty session)";
	if (limit > 0 && text.length > limit) return `${text.slice(0, limit)}…`;
	return text;
}

/** Short label for an active run phase, for status pills. */
export function runPhaseLabel(phase: RunPhase | undefined): string {
	switch (phase) {
		case "preparing-workspace":
			return "preparing";
		case "queued":
			return "queued";
		case "starting-box":
			return "starting box";
		default:
			return "running";
	}
}

/** Millisecond ordering value; unparseable timestamps sort last. */
export function timestampValue(timestamp: number | string): number {
	const date = toDate(timestamp);
	return date ? date.getTime() : 0;
}
