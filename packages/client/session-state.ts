/**
 * Framework-free session stream state machine, shared by every client.
 *
 * The server drives a run by emitting `ServerEvent`s over SSE. Each client
 * folds those events into display-ready state the same way: text deltas and
 * tool calls accumulate in a draft, `turn_complete` flushes the draft into the
 * message list, and `run_finished` marks the run idle. Keeping that logic here
 * (rather than in each UI) means the terminal and web clients never drift.
 *
 * Pure and browser-safe: no Deno, DOM, or reactivity dependencies.
 */

import { createUIToolCall, type UIMessage, type UIToolCall } from "@vvtxn/relay/core/display.ts";
import type { PendingApprovalInfo, ServerEvent } from "./protocol.ts";

/** Agent activity shown by a client's status indicator. */
export type SessionStatus =
	| { kind: "idle" }
	| { kind: "thinking" }
	| { kind: "writing" }
	| { kind: "running_tool"; toolName: string };

/** Full fold state for one session's live event stream. */
export interface SessionStreamState {
	/** Finalized messages (persisted turns plus anything already flushed). */
	messages: UIMessage[];
	/** Text streamed so far for the in-flight assistant message. */
	draftText: string;
	/** Tool calls accumulated for the in-flight assistant message. */
	draftToolCalls: UIToolCall[];
	/** Maps tool call ids to their index within `draftToolCalls`. */
	toolCallIndex: Record<string, number>;
	/** True while a run is active on the session. */
	running: boolean;
	/** Current activity, for status displays. */
	status: SessionStatus;
	/** Authoritative token total reported by the server. */
	tokens: number;
	/** Authoritative cost total reported by the server. */
	cost: number;
	/** Pending tool approval, when the run is waiting on the user. */
	pendingApproval: PendingApprovalInfo | null;
}

export const initialSessionStreamState: SessionStreamState = {
	messages: [],
	draftText: "",
	draftToolCalls: [],
	toolCallIndex: {},
	running: false,
	status: { kind: "idle" },
	tokens: 0,
	cost: 0,
	pendingApproval: null,
};

/** True when the draft holds anything worth rendering. */
export function hasDraft(state: SessionStreamState): boolean {
	return state.draftText.length > 0 || state.draftToolCalls.length > 0;
}

/** The message list plus the in-flight draft, ready for rendering. */
export function viewMessages(state: SessionStreamState): UIMessage[] {
	if (!hasDraft(state)) return state.messages;
	return [...state.messages, { role: "agent", content: state.draftText, toolCalls: state.draftToolCalls }];
}

/** Move the current draft into `messages` (no-op when empty). */
export function flushDraft(state: SessionStreamState): SessionStreamState {
	if (!hasDraft(state)) return state;
	return {
		...state,
		messages: [...state.messages, { role: "agent", content: state.draftText, toolCalls: state.draftToolCalls }],
		draftText: "",
		draftToolCalls: [],
		toolCallIndex: {},
	};
}

/** Reset the draft without flushing it (used when switching sessions). */
export function resetSessionStreamState(): SessionStreamState {
	return { ...initialSessionStreamState, messages: [] };
}

/**
 * Apply one server event, returning the next state. Pure: callers hold the
 * state in whatever reactive primitive their UI uses.
 */
export function applyServerEvent(state: SessionStreamState, event: ServerEvent): SessionStreamState {
	switch (event.type) {
		case "run_state": {
			const toolCallIndex: Record<string, number> = {};
			const draftToolCalls = event.toolCalls.map((tc, i) => {
				toolCallIndex[tc.id] = i;
				return {
					...createUIToolCall(tc.name, tc.args),
					output: tc.result?.content ?? "",
					...(tc.result?.meta?.diff ? { diff: tc.result.meta.diff } : {}),
				};
			});
			return {
				...state,
				draftText: event.draftText,
				draftToolCalls,
				toolCallIndex,
				running: true,
				status: { kind: "thinking" },
				tokens: event.tokens,
				cost: event.cost,
				pendingApproval: event.pendingApproval,
			};
		}
		case "text_delta":
			return {
				...state,
				draftText: state.draftText + event.content,
				status: { kind: "writing" },
			};
		case "tool_call_start":
			return { ...state, status: { kind: "running_tool", toolName: event.name } };
		case "tool_call_args_delta":
			return state;
		case "tool_call_end": {
			const index = state.draftToolCalls.length;
			return {
				...state,
				draftToolCalls: [...state.draftToolCalls, createUIToolCall(event.name, event.args)],
				toolCallIndex: { ...state.toolCallIndex, [event.id]: index },
				status: { kind: "running_tool", toolName: event.name },
			};
		}
		case "tool_result": {
			const index = state.toolCallIndex[event.id];
			if (index === undefined || index >= state.draftToolCalls.length) return state;
			const existing = state.draftToolCalls[index];
			if (!existing) return state;
			const draftToolCalls = [...state.draftToolCalls];
			draftToolCalls[index] = {
				...existing,
				output: event.result.content,
				...(event.result.meta?.diff ? { diff: event.result.meta.diff } : {}),
			};
			return { ...state, draftToolCalls };
		}
		case "message_complete":
			return {
				...state,
				tokens: event.tokens,
				cost: event.cost,
				status: { kind: "thinking" },
			};
		case "turn_complete":
			return { ...flushDraft(state), status: { kind: "thinking" } };
		case "approval_required":
			return { ...state, pendingApproval: event.approval };
		case "approval_resolved":
			if (state.pendingApproval?.toolCallId !== event.toolCallId) return state;
			return { ...state, pendingApproval: null };
		case "error":
			return {
				...state,
				messages: [...state.messages, { role: "agent", content: `**Error:** ${event.message}` }],
			};
		case "run_finished": {
			const flushed = flushDraft(state);
			return {
				...flushed,
				running: false,
				status: { kind: "idle" },
				pendingApproval: null,
			};
		}
	}
}
