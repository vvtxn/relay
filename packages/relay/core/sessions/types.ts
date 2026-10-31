import type { Effect } from "effect";
import type { ToolCall } from "#/api/types.ts";
import type { StoreError } from "../effect.ts";

// ---------------------------------------------------------------------------
// Session header — first line of every .jsonl file
// ---------------------------------------------------------------------------

export interface SessionHeader {
	type: "session";
	version: number;
	id: string;
	timestamp: string;
	cwd: string;
	tokens?: number;
	cost?: number;
}

// ---------------------------------------------------------------------------
// Entry types — every line after the header is one of these
// ---------------------------------------------------------------------------

export interface EntryBase {
	type: string;
	id: string;
	timestamp: string;
}

export interface MessageEntry extends EntryBase {
	type: "message";
	role: "user" | "assistant";
	content: string | null;
	toolCalls?: ToolCall[];
}

export interface ToolResultEntry extends EntryBase {
	type: "tool_result";
	toolCallId: string;
	toolName: string;
	content: string;
	isError?: boolean;
	/** Unified diff from file-editing tools, so reloaded transcripts can still show the change. */
	diff?: string;
}

export type Entry = MessageEntry | ToolResultEntry;

/** Entry input before the store assigns its id and timestamp. */
export type NewEntry = Omit<MessageEntry, "id" | "timestamp"> | Omit<ToolResultEntry, "id" | "timestamp">;

// ---------------------------------------------------------------------------
// In-memory session
// ---------------------------------------------------------------------------

export interface Session {
	header: SessionHeader;
	entries: Entry[];
}

/** Lifecycle phase of an active run, shared by the server and every client. */
export type RunPhase = "preparing-workspace" | "queued" | "starting-box" | "running" | "syncing";

export interface SessionSummary {
	id: string;
	/** Opaque value passed back to SessionStore.open(). */
	reference: string;
	timestamp: string;
	firstUserMessage: string | null;
	/** True while a run is active on the session. */
	running?: boolean;
	/** Phase of the active run, when `running` is true. */
	runPhase?: RunPhase;
}

/** Aggregated per-workspace info for a client's workspace picker. */
export interface WorkspaceSummary {
	cwd: string;
	sessionCount: number;
	lastActivity: string;
	/** False when the directory no longer exists on the server (stale workspace). */
	exists?: boolean;
}

export interface SessionScope {
	ownerId: string;
	cwd: string;
}

/**
 * Storage-backed session handle shared by filesystem and database stores.
 * Async operations are Effects; reads of in-memory state stay synchronous.
 */
export interface SessionHandle {
	append(entry: NewEntry): Effect.Effect<string, StoreError>;
	getEntries(): Entry[];
	getHeader(): SessionHeader;
	getTokens(): number;
	setTokens(tokens: number): void;
	getCost(): number;
	setCost(cost: number): void;
	flush(): Effect.Effect<void, StoreError>;
}

/** Minimal store contract required by frontends to manage sessions. */
export interface SessionStore {
	create(scope: SessionScope): SessionHandle;
	continueRecent(scope: SessionScope): Effect.Effect<SessionHandle | null, StoreError>;
	open(reference: string, ownerId: string): Effect.Effect<SessionHandle, StoreError>;
	listSummaries(scope: SessionScope): Effect.Effect<SessionSummary[], StoreError>;
}

export const CURRENT_VERSION = 1;
