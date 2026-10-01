import type { ToolCall } from "@/api/types.ts";

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
}

export type Entry = MessageEntry | ToolResultEntry;

/** Entry input before the store assigns its id and timestamp. */
export type NewEntry =
	| Omit<MessageEntry, "id" | "timestamp">
	| Omit<ToolResultEntry, "id" | "timestamp">;

// ---------------------------------------------------------------------------
// In-memory session
// ---------------------------------------------------------------------------

export interface Session {
	header: SessionHeader;
	entries: Entry[];
}

export interface SessionSummary {
	id: string;
	/** Opaque value passed back to SessionStore.open(). */
	reference: string;
	timestamp: string;
	firstUserMessage: string | null;
}

/** Aggregated per-workspace info for a client's workspace picker. */
export interface WorkspaceSummary {
	cwd: string;
	sessionCount: number;
	lastActivity: string;
}

export interface SessionScope {
	ownerId: string;
	cwd: string;
}

/** Storage-backed session handle shared by filesystem and database stores. */
export interface SessionHandle {
	append(entry: NewEntry): Promise<string>;
	getEntries(): Entry[];
	getHeader(): SessionHeader;
	getTokens(): number;
	setTokens(tokens: number): void;
	getCost(): number;
	setCost(cost: number): void;
	flush(): Promise<void>;
}

/** Minimal store contract required by frontends to manage sessions. */
export interface SessionStore {
	create(scope: SessionScope): SessionHandle;
	continueRecent(scope: SessionScope): Promise<SessionHandle | null>;
	open(reference: string, ownerId: string): Promise<SessionHandle>;
	listSummaries(scope: SessionScope): Promise<SessionSummary[]>;
}

export const CURRENT_VERSION = 1;
