import { createSignal } from "solid-js";
import { Effect, Stream } from "effect";
import type { Fiber } from "effect";
import {
	applyServerEvent,
	initialSessionStreamState,
	resetSessionStreamState,
	type SessionStreamState,
} from "@vvtxn/client/session-state.ts";
import type { ServerEvent } from "@vvtxn/client/protocol.ts";
import { entriesToUIMessages } from "@vvtxn/relay/core/display.ts";
import { fork, interrupt } from "@/api/runtime.ts";
import { SessionStream } from "@/api/services.ts";
import { queryClient, queryKeys } from "@/api/query-client.ts";

const [streamState, setStreamState] = createSignal<SessionStreamState>(initialSessionStreamState);
export { streamState };

let current = initialSessionStreamState;
let fiber: Fiber.RuntimeFiber<void, never> | null = null;
let abort: AbortController | null = null;

function commit(next: SessionStreamState): void {
	current = next;
	setStreamState(next);
}

/** Seed the live state with persisted entries (source of truth on open). */
export function hydrateSession(entries: Parameters<typeof entriesToUIMessages>[0], tokens: number, cost: number): void {
	commit({
		...current,
		messages: entriesToUIMessages(entries),
		draftText: "",
		draftToolCalls: [],
		toolCallIndex: {},
		tokens,
		cost,
	});
}

export function resetSession(): void {
	commit(resetSessionStreamState());
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
				Stream.runForEach(
					service.events(sessionId, signal),
					(event) =>
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

export function startStream(sessionId: string): void {
	stopStream();
	const controller = new AbortController();
	abort = controller;
	fiber = fork(streamProgram(sessionId, controller.signal));
}

export function stopStream(): void {
	abort?.abort();
	abort = null;
	if (fiber) {
		interrupt(fiber);
		fiber = null;
	}
}
