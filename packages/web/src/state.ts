import { signal } from "@preact/signals";
import { createUIToolCall, entriesToUIMessages, type UIMessage, type UIToolCall } from "@vvtxn/relay/core/display.ts";
import type { MeResponse, PendingApprovalInfo, ServerEvent, SessionSummary } from "@vvtxn/client/protocol.ts";
import { client } from "./api.ts";

const CWD_STORAGE_KEY = "relay.cwd";

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export const bootError = signal<string | null>(null);
export const booted = signal(false);

export const user = signal<MeResponse | null>(null);
export const cwd = signal("");
export const sessions = signal<SessionSummary[]>([]);

export const sessionId = signal<string | null>(null);
export const messages = signal<UIMessage[]>([]);
export const branch = signal<string | null>(null);

export const draftText = signal("");
export const draftToolCalls = signal<UIToolCall[]>([]);
export const isRunning = signal(false);
export const statusText = signal("");
export const streamReady = signal(false);

export const tokens = signal(0);
export const cost = signal(0);

export const pendingApproval = signal<PendingApprovalInfo | null>(null);
export const errorText = signal<string | null>(null);

// Non-reactive bookkeeping
let toolCallIndex = new Map<string, number>();
let streamAbort: AbortController | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function showError(message: string): void {
	errorText.value = message;
	setTimeout(() => {
		if (errorText.value === message) errorText.value = null;
	}, 8000);
}

function flushDraft(): void {
	if (!draftText.value.trim() && draftToolCalls.value.length === 0) return;
	messages.value = [
		...messages.value,
		{ role: "agent", content: draftText.value, toolCalls: [...draftToolCalls.value] },
	];
	draftText.value = "";
	draftToolCalls.value = [];
	toolCallIndex = new Map();
}

function setDraftToolCalls(calls: UIToolCall[]): void {
	draftToolCalls.value = [...calls];
}

// ---------------------------------------------------------------------------
// SSE event folding — mirrors the CLI's runSubmission draft handling
// ---------------------------------------------------------------------------

function foldEvent(event: ServerEvent): void {
	switch (event.type) {
		case "run_state": {
			const calls: UIToolCall[] = [];
			toolCallIndex = new Map();
			event.toolCalls.forEach((tc, i) => {
				toolCallIndex.set(tc.id, i);
				calls.push({
					...createUIToolCall(tc.name, tc.args),
					output: tc.result?.content ?? "",
					diff: tc.result?.meta?.diff,
				});
			});
			draftText.value = event.draftText;
			setDraftToolCalls(calls);
			tokens.value = event.tokens;
			cost.value = event.cost;
			pendingApproval.value = event.pendingApproval;
			isRunning.value = true;
			statusText.value = event.pendingApproval ? "Waiting for approval..." : "Working...";
			break;
		}
		case "text_delta":
			draftText.value += event.content;
			statusText.value = "Writing...";
			break;
		case "tool_call_start":
			statusText.value = `Running ${event.name}...`;
			break;
		case "tool_call_end": {
			const calls = draftToolCalls.value;
			toolCallIndex.set(event.id, calls.length);
			setDraftToolCalls([...calls, createUIToolCall(event.name, event.args)]);
			statusText.value = `Running ${event.name}...`;
			break;
		}
		case "tool_result": {
			const at = toolCallIndex.get(event.id);
			if (at !== undefined) {
				const calls = [...draftToolCalls.value];
				if (at < calls.length) {
					calls[at] = { ...calls[at], output: event.result.content, diff: event.result.meta?.diff };
					setDraftToolCalls(calls);
				}
			}
			break;
		}
		case "message_complete":
			tokens.value = event.tokens;
			cost.value = event.cost;
			statusText.value = "Thinking...";
			break;
		case "turn_complete":
			flushDraft();
			statusText.value = "Thinking...";
			break;
		case "approval_required":
			pendingApproval.value = event.approval;
			statusText.value = "Waiting for approval...";
			break;
		case "approval_resolved":
			if (pendingApproval.value?.toolCallId === event.toolCallId) pendingApproval.value = null;
			break;
		case "error":
			showError(event.message);
			break;
		case "run_finished":
			flushDraft();
			isRunning.value = false;
			statusText.value = "";
			pendingApproval.value = null;
			// The server is the source of truth — rebuild from persisted entries
			void refreshSession();
			break;
	}
}

// ---------------------------------------------------------------------------
// SSE subscription with reconnect + backoff
// ---------------------------------------------------------------------------

export function stopStream(): void {
	streamAbort?.abort();
	streamAbort = null;
	streamReady.value = false;
}

export function startStream(): void {
	stopStream();
	const id = sessionId.value;
	if (!id) return;

	const ac = new AbortController();
	streamAbort = ac;
	let backoffMs = 500;

	void (async () => {
		while (!ac.signal.aborted && sessionId.value === id) {
			try {
				for await (
					const event of client.subscribe(id, {
						signal: ac.signal,
						onOpen: () => {
							streamReady.value = true;
							backoffMs = 500;
						},
					})
				) {
					if (sessionId.value !== id) break;
					foldEvent(event);
				}
			} catch (error) {
				if (ac.signal.aborted || sessionId.value !== id) break;
				errorText.value = `Stream error: ${error instanceof Error ? error.message : String(error)}`;
			}
			if (ac.signal.aborted || sessionId.value !== id) break;
			streamReady.value = false;
			await new Promise((resolve) => setTimeout(resolve, backoffMs));
			backoffMs = Math.min(backoffMs * 2, 5000);
		}
	})();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function loadSessions(): Promise<void> {
	if (!cwd.value) return;
	try {
		const response = await client.listSessions(cwd.value);
		sessions.value = response.sessions;
	} catch (error) {
		showError(`Failed to load sessions: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function refreshSession(): Promise<void> {
	const id = sessionId.value;
	if (!id) return;
	try {
		const response = await client.openSession(id);
		if (sessionId.value !== id) return;
		messages.value = entriesToUIMessages(response.entries);
		tokens.value = response.tokens;
		cost.value = response.cost;
		branch.value = response.branch;
		draftText.value = "";
		draftToolCalls.value = [];
	} catch (error) {
		showError(`Failed to load session: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function openSession(id: string): Promise<void> {
	if (sessionId.value === id) return;
	sessionId.value = id;
	messages.value = [];
	draftText.value = "";
	draftToolCalls.value = [];
	pendingApproval.value = null;
	isRunning.value = false;
	await refreshSession();
	startStream();
}

export async function newSession(): Promise<void> {
	try {
		const response = await client.createSession(cwd.value || "/");
		sessionId.value = response.id;
		messages.value = [];
		draftText.value = "";
		draftToolCalls.value = [];
		pendingApproval.value = null;
		isRunning.value = false;
		tokens.value = 0;
		cost.value = 0;
		branch.value = null;
		startStream();
		await loadSessions();
	} catch (error) {
		showError(`Failed to create session: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function setCwd(value: string): void {
	cwd.value = value;
	try {
		localStorage.setItem(CWD_STORAGE_KEY, value);
	} catch {
		// Ignore storage failures
	}
	void loadSessions();
}

export async function submit(content: string): Promise<void> {
	const id = sessionId.value;
	if (!id || isRunning.value || !content.trim()) return;

	messages.value = [...messages.value, { role: "user", content }];
	isRunning.value = true;
	statusText.value = "Thinking...";

	try {
		await client.sendMessage(id, content);
	} catch (error) {
		isRunning.value = false;
		statusText.value = "";
		showError(`Failed to send: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function resolveApproval(decision: "allow" | "always" | "deny"): Promise<void> {
	const id = sessionId.value;
	const approval = pendingApproval.value;
	if (!id || !approval) return;
	try {
		await client.approve(id, approval.toolCallId, decision);
		// pendingApproval clears via the approval_resolved event
	} catch (error) {
		showError(`Failed to respond: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function cancelRun(): Promise<void> {
	const id = sessionId.value;
	if (!id || !isRunning.value) return;
	try {
		await client.cancel(id);
	} catch (error) {
		showError(`Failed to cancel: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export async function bootstrap(): Promise<void> {
	try {
		const me = await client.me();
		user.value = me;

		let stored: string | null = null;
		try {
			stored = localStorage.getItem(CWD_STORAGE_KEY);
		} catch {
			// Ignore storage failures
		}
		if (stored) {
			cwd.value = stored;
		} else {
			const workspace = await client.workspace();
			cwd.value = workspace.cwd;
		}

		booted.value = true;
		await loadSessions();

		// Open the most recent session for this workspace, or create one
		if (sessions.value.length > 0) {
			await openSession(sessions.value[0].reference);
		} else {
			await newSession();
		}
	} catch (error) {
		booted.value = true;
		bootError.value = error instanceof Error ? error.message : String(error);
	}
}
