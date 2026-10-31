/**
 * Wire protocol shared by the Relay server and its clients (CLI, web).
 *
 * Every type here is plain JSON — no runtime dependencies — so the
 * protocol can be consumed from any runtime. The SSE event payloads mirror the
 * agent runner callbacks one-to-one, plus server-side lifecycle events.
 */

import type {
	Entry,
	RunPhase,
	SessionHeader,
	SessionSummary,
	WorkspaceSummary,
} from "@vvtxn/relay/core/sessions/index.ts";
import type { WorkspaceRejection } from "@vvtxn/relay/core/workspace.ts";
import type { ToolResult } from "@vvtxn/relay/core/tools/index.ts";
import type { Usage } from "@vvtxn/relay/api/types.ts";

export type { RunPhase, SessionSummary };

// ---------------------------------------------------------------------------
// REST payloads
// ---------------------------------------------------------------------------

export interface HealthResponse {
	status: "ok";
	version: string;
	/** Product mode the server is running in. */
	flavor: "local" | "cloud";
}

export interface MeResponse {
	id: string;
	name?: string;
	provider?: string;
	/** Avatar URL from the identity provider, when available. */
	avatarUrl?: string;
}

/** The server's default workspace directory (used to scope sessions). */
export interface WorkspaceResponse {
	cwd: string;
}

/** Model + context info for status displays. */
export interface ConfigResponse {
	model: string;
	/** Context window budget used for the token bar. */
	contextTokens: number;
	/** Maximum sessions (threads) kept per workspace; `0` means unlimited. */
	maxSessionsPerWorkspace: number;
	/** Server user's home directory, used to abbreviate/expand `~` paths. */
	home: string;
	/** Origin where the browser client is reachable (for "open in browser"). */
	webUrl: string;
}

/**
 * Per-user settings. The API key itself is never returned — clients learn only
 * whether one is set and a short masked hint so they can display it.
 */
export interface SettingsResponse {
	apiKey: {
		set: boolean;
		/** Last few characters of the stored key, or null when unset. */
		hint: string | null;
	};
}

/** Set the caller's LLM API key, or clear it by sending null/empty. */
export interface SetApiKeyRequest {
	apiKey: string | null;
}

export interface SessionListResponse {
	sessions: SessionSummary[];
}

/** One active agent run, owned by the server's RunManager. */
export interface RunSummary {
	runId: string;
	/** Session key accepted by the session routes. */
	sessionId: string;
	cwd: string;
	phase: RunPhase;
	startedAt: string;
	boxId?: string;
	/** Position in the box-acquisition queue when `phase` is "queued". */
	queuePosition?: number;
}

export interface RunListResponse {
	runs: RunSummary[];
}

/** Distinct workspaces (project directories) with sessions for the user. */
export interface WorkspacesResponse {
	workspaces: WorkspaceSummary[];
}

/** Result of `GET /api/workspaces/validate`. Always 200 — `ok` carries the outcome. */
export interface WorkspaceValidateResponse {
	ok: boolean;
	/** Canonical absolute path (symlinks resolved) when `ok`. */
	path?: string;
	/** Machine-readable rejection reason when not `ok`. */
	reason?: WorkspaceRejection;
	/** Human-readable message, safe to render verbatim. */
	message?: string;
	/** Roots the server enforces; empty means "any directory". */
	roots: string[];
}

export interface RegisterWorkspaceRequest {
	cwd: string;
}

export interface RegisterWorkspaceResponse {
	workspace: WorkspaceSummary;
}

export interface CreateSessionRequest {
	cwd: string;
	/** Skip idle-empty reuse and force a fresh thread. */
	forceNew?: boolean;
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
	/** Branch where this thread's changes are committed, when thread branches are enabled. */
	threadBranch?: string;
	/** True while a run is active on this session (another client may be driving it). */
	running: boolean;
	/** Phase of the active run, when `running` is true. */
	runPhase?: RunPhase;
	/** The box leased by this session's active run, when boxes are enabled. */
	box?: BoxSummary;
}

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

export type BoxProfileName = "tiny" | "small" | "medium";

export type BoxLifecycleState = "provisioning" | "starting" | "ready" | "busy" | "paused" | "stopped" | "error";

/** A managed execution box. Boxes are pooled per project and leased by runs. */
export interface BoxSummary {
	boxId: string;
	state: BoxLifecycleState;
	/** OCI image backing this box (for example `relay-box:local`). */
	image: string;
	/** Named profile, or "custom" when a project overrides exact resources. */
	profile: BoxProfileName | "custom";
	cpus: number;
	memoryMiB: number;
	rootDiskMiB: number;
	createdAt: string;
	lastUsedAt: string;
	pausedAt?: string;
	error?: string;
	capacity?: {
		maxRunning: number;
		running: number;
		/** Runs waiting for a box lease. */
		queued?: number;
		maxCpus: number;
		usedCpus: number;
		maxMemoryMiB: number;
		usedMemoryMiB: number;
	};
}

export interface BoxListResponse {
	boxes: BoxSummary[];
}

export interface BoxResponse {
	box: BoxSummary;
}

export interface CreateBoxRequest {
	/** Project directory to clone. Defaults to the server workspace. */
	cwd?: string;
	profile?: BoxProfileName;
}

export interface BoxResizeRequest {
	profile: BoxProfileName;
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

/** Snapshot sent immediately on subscribe while a run is in progress. */
export interface RunStateEvent {
	type: "run_state";
	runId: string;
	phase: RunPhase;
	/** Text streamed so far for the in-flight assistant message. */
	draftText: string;
	/** Tool calls that have completed streaming args (may or may not have results yet). */
	toolCalls: { id: string; name: string; args: string; result?: ToolResult }[];
	tokens: number;
	cost: number;
	boxId?: string;
	queuePosition?: number;
}

export type ServerEvent =
	| RunStateEvent
	| {
			type: "run_status";
			runId: string;
			phase: RunPhase;
			boxId?: string;
			queuePosition?: number;
	  }
	| { type: "text_delta"; content: string }
	| { type: "tool_call_start"; id: string; name: string }
	| { type: "tool_call_args_delta"; id: string; args: string }
	| { type: "tool_call_end"; id: string; name: string; args: string }
	| { type: "tool_result"; id: string; result: ToolResult }
	| { type: "message_complete"; usage?: Usage; tokens: number; cost: number }
	| { type: "turn_complete" }
	| { type: "run_finished"; reason: "completed" | "cancelled" | "error" }
	| { type: "error"; message: string };
