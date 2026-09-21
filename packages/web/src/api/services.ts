import { Context, Data, Effect, Layer, Stream } from "effect";
import { RelayApiError, type SubscribeOptions } from "@vvtxn/client/client.ts";
import type {
	ApprovalDecision,
	AuthInfoResponse,
	ConfigResponse,
	CreateSessionResponse,
	FileListResponse,
	HealthResponse,
	MeResponse,
	OpenSessionResponse,
	SendMessageResponse,
	ServerEvent,
	SessionListResponse,
	StatusResponse,
	WorkspaceResponse,
} from "@vvtxn/client/protocol.ts";
import { client } from "./client.ts";

/** Tagged failure for every Relay transport operation. */
export class RelayError extends Data.TaggedError("RelayError")<{
	readonly message: string;
	readonly status?: number;
	readonly cause?: unknown;
}> {}

/** True when the server rejected the request as unauthenticated. */
export function isUnauthorized(error: RelayError): boolean {
	return error.status === 401;
}

function toRelayError(cause: unknown): RelayError {
	if (cause instanceof RelayApiError) {
		return new RelayError({ message: cause.message, status: cause.status, cause });
	}
	return new RelayError({
		message: cause instanceof Error ? cause.message : String(cause),
		cause,
	});
}

function tryRelay<A>(run: () => Promise<A>): Effect.Effect<A, RelayError> {
	return Effect.tryPromise({ try: run, catch: toRelayError });
}

/** Effect-native wrapper over the Relay REST + SSE client. */
export interface ApiShape {
	health(): Effect.Effect<HealthResponse, RelayError>;
	me(): Effect.Effect<MeResponse, RelayError>;
	workspace(): Effect.Effect<WorkspaceResponse, RelayError>;
	getConfig(): Effect.Effect<ConfigResponse, RelayError>;
	getAuthInfo(): Effect.Effect<AuthInfoResponse, RelayError>;
	listSessions(cwd: string): Effect.Effect<SessionListResponse, RelayError>;
	createSession(cwd: string): Effect.Effect<CreateSessionResponse, RelayError>;
	openSession(id: string): Effect.Effect<OpenSessionResponse, RelayError>;
	listFiles(sessionId: string): Effect.Effect<FileListResponse, RelayError>;
	sendMessage(sessionId: string, content: string): Effect.Effect<SendMessageResponse, RelayError>;
	approve(
		sessionId: string,
		toolCallId: string,
		decision: ApprovalDecision,
	): Effect.Effect<StatusResponse, RelayError>;
	cancel(sessionId: string): Effect.Effect<StatusResponse, RelayError>;
	/** Raw SSE subscription; consumed by {@link SessionStream}. */
	subscribe(sessionId: string, options: SubscribeOptions): AsyncIterable<ServerEvent>;
}

export class Api extends Context.Tag("relay/Api")<Api, ApiShape>() {}

export const ApiLive = Layer.succeed(Api, {
	health: () => tryRelay(() => client.health()),
	me: () => tryRelay(() => client.me()),
	workspace: () => tryRelay(() => client.workspace()),
	getConfig: () => tryRelay(() => client.getConfig()),
	getAuthInfo: () => tryRelay(() => client.getAuthInfo()),
	listSessions: (cwd) => tryRelay(() => client.listSessions(cwd)),
	createSession: (cwd) => tryRelay(() => client.createSession(cwd)),
	openSession: (id) => tryRelay(() => client.openSession(id)),
	listFiles: (sessionId) => tryRelay(() => client.listFiles(sessionId)),
	sendMessage: (sessionId, content) => tryRelay(() => client.sendMessage(sessionId, content)),
	approve: (sessionId, toolCallId, decision) => tryRelay(() => client.approve(sessionId, toolCallId, decision)),
	cancel: (sessionId) => tryRelay(() => client.cancel(sessionId)),
	subscribe: (sessionId, options) => client.subscribe(sessionId, options),
});

/** SSE event stream for a session, as an Effect Stream. */
export interface SessionStreamShape {
	events(sessionId: string, signal: AbortSignal): Stream.Stream<ServerEvent, RelayError>;
}

export class SessionStream extends Context.Tag("relay/SessionStream")<SessionStream, SessionStreamShape>() {}

export const SessionStreamLive = Layer.effect(
	SessionStream,
	Effect.map(Api, (api): SessionStreamShape => ({
		events: (sessionId, signal) => Stream.fromAsyncIterable(api.subscribe(sessionId, { signal }), toRelayError),
	})),
);

/** Full application layer: REST API + session stream, both available downstream. */
export const AppLayer = SessionStreamLive.pipe(Layer.provideMerge(ApiLive));
