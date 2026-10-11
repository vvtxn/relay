import { createSignal } from "solid-js";
import { Effect, Stream } from "effect";
import type { Fiber } from "effect";
import {
	applyServerEvent,
	initialSessionStreamState,
	resetSessionStreamState,
	type SessionStreamState,
} from "@vvtxn/client/session-state.ts";
import type { OpenSessionResponse, ServerEvent } from "@vvtxn/client/protocol.ts";
import { entriesToUIMessages } from "@vvtxn/relay/core/display.ts";
import { fork, interrupt } from "#/api/runtime.ts";
import { SessionStream } from "#/api/services.ts";
import { queryClient, queryKeys } from "#/api/query-client.ts";
import { writeStoredSessionId } from "#/api/storage.ts";

const [streamState, setStreamState] = createSignal<SessionStreamState>(initialSessionStreamState);
export { streamState };

let current = initialSessionStreamState;
let fiber: Fiber.Fiber<void> | null = null;
let abort: AbortController | null = null;
let activeSessionId: string | null = null;
let streamingSessionId: string | null = null;

function commit(next: SessionStreamState): void {
	current = next;
	setStreamState(next);
}

/**
 * Seed the live store from a persisted snapshot. Only the first call for a
 * session applies — later refetches and re-renders must never clobber streamed
 * state (or restart the stream).
 */
export function ensureSession(id: string, session: OpenSessionResponse): void {
	if (activeSessionId === id) return;
	activeSessionId = id;
	writeStoredSessionId(id);
	commit({
		...resetSessionStreamState(),
		messages: entriesToUIMessages(session.entries),
		tokens: session.tokens,
		cost: session.cost,
		running: session.running,
		status: session.running ? { kind: "thinking" } : { kind: "idle" },
	});
}

/** Optimistically append the user's message and mark the run active. */
export function appendUserMessage(content: string): void {
	commit({
		...current,
		messages: [...current.messages, { role: "user", content }],
		running: true,
		status: { kind: "thinking" },
	});
}

/** Record a client-side error (transport failure, stream error). */
export function appendError(message: string): void {
	commit(applyServerEvent(current, { type: "error", message }));
}

export function setRunning(running: boolean): void {
	commit({ ...current, running, status: running ? current.status : { kind: "idle" } });
}

function handleEvent(sessionId: string, event: ServerEvent): void {
	commit(applyServerEvent(current, event));
	if (event.type !== "run_finished") return;
	void queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) });
	void queryClient.invalidateQueries({ queryKey: ["sessions"] });
	void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
}

/**
 * Reconnect loop: consume the SSE stream, and when it ends (server idle
 * shutdown) or fails, wait with exponential backoff before resubscribing.
 * Runs as a fiber so it can be interrupted on navigation.
 */
function streamProgram(sessionId: string, signal: AbortSignal): Effect.Effect<void, never, SessionStream> {
	return Effect.gen(function* () {
		const service = yield* SessionStream;
		let backoff = 500;
		while (!signal.aborted) {
			yield* Effect.exit(
				Stream.runForEach(service.events(sessionId, signal), (event) =>
					Effect.sync(() => {
						backoff = 500;
						handleEvent(sessionId, event);
					}),
				),
			);
			if (signal.aborted) break;
			backoff = Math.min(backoff * 2, 5000);
			yield* Effect.sleep(backoff);
		}
	});
}

/**
 * Stop the live stream. The session's persisted snapshot is marked stale: the
 * only authoritative view of it is the stream, so any events that arrive while
 * detached (another client, a run finishing) must be re-fetched on re-entry.
 */
export function stopStream(): void {
	const stopped = streamingSessionId;
	streamingSessionId = null;
	abort?.abort();
	abort = null;
	if (fiber) {
		interrupt(fiber);
		fiber = null;
	}
	if (stopped) void queryClient.invalidateQueries({ queryKey: queryKeys.session(stopped) });
}

/** Attach the live stream once per session; repeating the same id is a no-op. */
export function startStream(sessionId: string): void {
	if (streamingSessionId === sessionId) return;
	stopStream();
	streamingSessionId = sessionId;
	const controller = new AbortController();
	abort = controller;
	fiber = fork(streamProgram(sessionId, controller.signal));
}
