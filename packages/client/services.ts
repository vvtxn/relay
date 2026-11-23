/**
 * Effect service layer over the plain promise-based {@link RelayClient}.
 *
 * The transport itself stays Effect-free (it also runs in environments without
 * a runtime); this module is the composition seam for Effect-native clients:
 * the web app and the CLI install their own configured `RelayClient` via
 * {@link appLayer}.
 */

import { Context, Data, Effect, Layer, Stream } from "effect";
import { RelayApiError, type RelayClient, type SubscribeOptions } from "./client.ts";
import type {
	ConfigResponse,
	CreateSessionResponse,
	FileListResponse,
	HealthResponse,
	MeResponse,
	ModelCatalogResponse,
	ModelsResponse,
	OAuthCompleteResponse,
	OAuthStartResponse,
	OpenSessionResponse,
	RegisterWorkspaceResponse,
	SendMessageRequest,
	SendMessageResponse,
	ServerEvent,
	SessionListResponse,
	SetConnectionResponse,
	SettingsResponse,
	StatusResponse,
	UpdateSettingsRequest,
	WorkspaceResponse,
	WorkspacesResponse,
	WorkspaceValidateResponse,
} from "./protocol.ts";

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
	getSettings(): Effect.Effect<SettingsResponse, RelayError>;
	updateSettings(settings: UpdateSettingsRequest): Effect.Effect<StatusResponse, RelayError>;
	listModels(preset: string): Effect.Effect<ModelsResponse, RelayError>;
	listModelCatalog(): Effect.Effect<ModelCatalogResponse, RelayError>;
	startOAuth(provider: string): Effect.Effect<OAuthStartResponse, RelayError>;
	completeOAuth(provider: string, code: string): Effect.Effect<OAuthCompleteResponse, RelayError>;
	disconnectOAuth(provider: string): Effect.Effect<OAuthCompleteResponse, RelayError>;
	cancelOAuth(provider: string): Effect.Effect<StatusResponse, RelayError>;
	setConnection(preset: string, apiKey: string): Effect.Effect<SetConnectionResponse, RelayError>;
	removeConnection(preset: string): Effect.Effect<SetConnectionResponse, RelayError>;
	listSessions(cwd: string): Effect.Effect<SessionListResponse, RelayError>;
	listWorkspaces(): Effect.Effect<WorkspacesResponse, RelayError>;
	validateWorkspace(cwd: string): Effect.Effect<WorkspaceValidateResponse, RelayError>;
	registerWorkspace(cwd: string): Effect.Effect<RegisterWorkspaceResponse, RelayError>;
	unregisterWorkspace(cwd: string): Effect.Effect<StatusResponse, RelayError>;
	createSession(cwd: string, options?: { forceNew?: boolean }): Effect.Effect<CreateSessionResponse, RelayError>;
	openSession(id: string): Effect.Effect<OpenSessionResponse, RelayError>;
	listFiles(sessionId: string): Effect.Effect<FileListResponse, RelayError>;
	sendMessage(
		sessionId: string,
		content: string,
		model?: SendMessageRequest["model"],
	): Effect.Effect<SendMessageResponse, RelayError>;
	cancel(sessionId: string): Effect.Effect<StatusResponse, RelayError>;
	/** Raw SSE subscription; consumed by {@link SessionStream}. */
	subscribe(sessionId: string, options: SubscribeOptions): AsyncIterable<ServerEvent>;
}

export class Api extends Context.Service<Api, ApiShape>()("relay/Api") {}

/** Wraps a configured client in the {@link Api} service. */
export const ApiLive = (client: RelayClient): Layer.Layer<Api> =>
	Layer.succeed(Api, {
		health: () => tryRelay(() => client.health()),
		me: () => tryRelay(() => client.me()),
		workspace: () => tryRelay(() => client.workspace()),
		getConfig: () => tryRelay(() => client.getConfig()),
		getSettings: () => tryRelay(() => client.getSettings()),
		updateSettings: (settings) => tryRelay(() => client.updateSettings(settings)),
		listModels: (preset) => tryRelay(() => client.listModels(preset)),
		listModelCatalog: () => tryRelay(() => client.listModelCatalog()),
		startOAuth: (provider) => tryRelay(() => client.startOAuth(provider)),
		completeOAuth: (provider, code) => tryRelay(() => client.completeOAuth(provider, code)),
		disconnectOAuth: (provider) => tryRelay(() => client.disconnectOAuth(provider)),
		cancelOAuth: (provider) => tryRelay(() => client.cancelOAuth(provider)),
		setConnection: (preset, apiKey) => tryRelay(() => client.setConnection(preset, apiKey)),
		removeConnection: (preset) => tryRelay(() => client.removeConnection(preset)),
		listSessions: (cwd) => tryRelay(() => client.listSessions(cwd)),
		listWorkspaces: () => tryRelay(() => client.listWorkspaces()),
		validateWorkspace: (cwd) => tryRelay(() => client.validateWorkspace(cwd)),
		registerWorkspace: (cwd) => tryRelay(() => client.registerWorkspace(cwd)),
		unregisterWorkspace: (cwd) => tryRelay(() => client.unregisterWorkspace(cwd)),
		createSession: (cwd, options) => tryRelay(() => client.createSession(cwd, options)),
		openSession: (id) => tryRelay(() => client.openSession(id)),
		listFiles: (sessionId) => tryRelay(() => client.listFiles(sessionId)),
		sendMessage: (sessionId, content, model) => tryRelay(() => client.sendMessage(sessionId, content, model)),
		cancel: (sessionId) => tryRelay(() => client.cancel(sessionId)),
		subscribe: (sessionId, options) => client.subscribe(sessionId, options),
	});

/** SSE event stream for a session, as an Effect Stream. */
export interface SessionStreamShape {
	events(sessionId: string, signal: AbortSignal): Stream.Stream<ServerEvent, RelayError>;
}

export class SessionStream extends Context.Service<SessionStream, SessionStreamShape>()("relay/SessionStream") {}

export const SessionStreamLive: Layer.Layer<SessionStream, never, Api> = Layer.effect(
	SessionStream,
	Effect.map(Api, (api): SessionStreamShape => ({
		events: (sessionId, signal) => Stream.fromAsyncIterable(api.subscribe(sessionId, { signal }), toRelayError),
	})),
);

/** Full application layer: REST API + session stream, both available downstream. */
export const appLayer = (client: RelayClient): Layer.Layer<Api | SessionStream> =>
	SessionStreamLive.pipe(Layer.provideMerge(ApiLive(client)));
