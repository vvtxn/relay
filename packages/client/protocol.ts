/**
 * Wire protocol shared by the Relay server and its clients (CLI, web).
 *
 * Every type here is plain JSON — no Deno or browser dependencies — so the
 * protocol can be consumed from any runtime. The SSE event payloads mirror the
 * agent runner callbacks one-to-one, plus server-side lifecycle events.
 */

import type { Entry, SessionHeader, SessionSummary } from "@vvtxn/relay/core/sessions/index.ts";
import type { ToolResult } from "@vvtxn/relay/core/tools/index.ts";
import type { Usage } from "@vvtxn/relay/api/types.ts";

// ---------------------------------------------------------------------------
// REST payloads
// ---------------------------------------------------------------------------

export interface HealthResponse {
	status: "ok";
	version: string;
}

export interface MeResponse {
	id: string;
	name?: string;
	provider?: string;
}

export interface SessionListResponse {
	sessions: SessionSummary[];
}

export interface CreateSessionRequest {
	cwd: string;
}

export interface CreateSessionResponse {
	id: string;
	header: SessionHeader;
}

export interface OpenSessionResponse {
	header: SessionHeader;
	entries: Entry[];
	tokens: number;
	cost: number;
	/** Current git branch of the session workspace, when available. */
	branch: string | null;
	/** True while a run is active on this session (another client may be driving it). */
	running: boolean;
}

export interface FileListResponse {
	cwd: string;
	files: string[];
}

export interface SendMessageRequest {
	content: string;
}

export interface SendMessageResponse {
	status: "started";
	sessionId: string;
}

export type ApprovalDecision = "allow" | "always" | "deny";

export interface ApprovalRequest {
	toolCallId: string;
	decision: ApprovalDecision;
}

export interface StatusResponse {
	status: "ok";
}

/** Error bodies always have this shape so clients can render them directly. */
export interface ErrorResponse {
	error: string;
}

// ---------------------------------------------------------------------------
// SSE events — `GET /api/sessions/:id/events`
// ---------------------------------------------------------------------------

/** Server-side display state for a pending approval. */
export interface PendingApprovalInfo {
	toolCallId: string;
	toolName: string;
	summary: string;
}

/** Snapshot sent immediately on subscribe while a run is in progress. */
export interface RunStateEvent {
	type: "run_state";
	/** Text streamed so far for the in-flight assistant message. */
	draftText: string;
	/** Tool calls that have completed streaming args (may or may not have results yet). */
	toolCalls: { id: string; name: string; args: string; result?: ToolResult }[];
	pendingApproval: PendingApprovalInfo | null;
	tokens: number;
	cost: number;
}

export type ServerEvent =
	| RunStateEvent
	| { type: "text_delta"; content: string }
	| { type: "tool_call_start"; id: string; name: string }
	| { type: "tool_call_args_delta"; id: string; args: string }
	| { type: "tool_call_end"; id: string; name: string; args: string }
	| { type: "tool_result"; id: string; result: ToolResult }
	| { type: "message_complete"; usage?: Usage; tokens: number; cost: number }
	| { type: "turn_complete" }
	| { type: "approval_required"; approval: PendingApprovalInfo }
	| { type: "approval_resolved"; toolCallId: string; decision: ApprovalDecision }
	| { type: "run_finished"; reason: "completed" | "cancelled" | "error" }
	| { type: "error"; message: string };
