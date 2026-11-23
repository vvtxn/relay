import { Context, Effect, Layer } from "effect";
import { chmodSync, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { BoxManager } from "@vvtxn/box/types.ts";
import { Boxes, boxesLayer } from "@vvtxn/box/service.ts";
import { createWorkspaceManager, type WorkspaceManager } from "@vvtxn/box/workspaces.ts";
import type { AuthenticatedUser, AuthIdentity } from "@vvtxn/relay/core/index.ts";
import {
	createSecretCipher,
	credentialExpired,
	DatabaseAuthSessionStore,
	DatabaseUserSettingsStore,
	DatabaseUserStore,
	FileUserSettingsStore,
	loadMasterKey,
	loadOrCreateLocalMasterKey,
	type OAuthCredential,
	type UserSettingsStore,
} from "@vvtxn/relay/core/index.ts";
import { createDatabaseClient, type DatabaseClient } from "@vvtxn/relay/core/database.ts";
import { causeMessage, storeEffect, toStoreError, type StoreError } from "@vvtxn/relay/core/effect.ts";
import type { LlmModelSelection } from "@vvtxn/relay/core/llm-presets.ts";
import { getLlmPreset } from "@vvtxn/relay/core/llm-presets.ts";
import { DatabaseSessionStore } from "@vvtxn/relay/core/sessions/index.ts";
import type { ServerConfig } from "./config.ts";
import { createRunLlm } from "./llm.ts";
import { refreshOAuthCredential } from "./oauth.ts";
import { RunManager } from "./run.ts";

/**
 * Long-lived services shared by every route handler.
 *
 * Composition lives in {@link serverLayer}: services are constructed as Effect
 * Layers and materialized into this bundle by {@link createServices} for the
 * current (promise-based) handlers. The authenticated user is resolved per
 * request and added in {@link RequestServices}, so the same server can host
 * multiple identities.
 */
export interface ServerServices {
	config: ServerConfig;
	db: DatabaseClient;
	userStore: DatabaseUserStore;
	userSettings: UserSettingsStore;
	authSessions: DatabaseAuthSessionStore;
	sessionStore: DatabaseSessionStore;
	runs: RunManager;
	workspaces: WorkspaceManager;
	/** The fixed identity used by local auth; null in GitHub mode. */
	localUser: AuthenticatedUser | null;
	boxes: BoxManager;
}

/** Base services plus the caller resolved for this request. */
export interface RequestServices extends ServerServices {
	user: AuthenticatedUser;
}

// ---------------------------------------------------------------------------
// Service tags
// ---------------------------------------------------------------------------

export class Config extends Context.Service<Config, ServerConfig>()("relay/server/Config") {}
export class Database extends Context.Service<Database, DatabaseClient>()("relay/server/Database") {}
export class UserStore extends Context.Service<UserStore, DatabaseUserStore>()("relay/server/UserStore") {}
export class UserSettings extends Context.Service<UserSettings, UserSettingsStore>()("relay/server/UserSettings") {}
export class AuthSessions extends Context.Service<AuthSessions, DatabaseAuthSessionStore>()(
	"relay/server/AuthSessions",
) {}
export class SessionStore extends Context.Service<SessionStore, DatabaseSessionStore>()("relay/server/SessionStore") {}
export class Runs extends Context.Service<Runs, RunManager>()("relay/server/Runs") {}
export class Workspaces extends Context.Service<Workspaces, WorkspaceManager>()("relay/server/Workspaces") {}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const configLayer = (config: ServerConfig) => Layer.succeed(Config, config);

/**
 * The shared database client. Local mode opens an embedded SQLite file; cloud
 * mode connects to Turso. The stores cannot tell the difference.
 */
const databaseLayer = Layer.effect(
	Database,
	Effect.gen(function* () {
		const config = yield* Config;
		if (config.database.kind === "local" && config.database.path !== ":memory:") {
			mkdirSync(dirname(config.database.path), { recursive: true, mode: 0o700 });
		}
		return createDatabaseClient({
			url: config.database.url,
			...(config.database.kind === "turso" ? { authToken: config.database.authToken } : {}),
		});
	}),
);

/**
 * All database stores, acquired in sequence on the shared client: `users`
 * backs the `auth_sessions` foreign key and concurrent DDL is best avoided.
 * Exported for advanced composition.
 */
export const storesLayer = Layer.effectContext(
	Effect.gen(function* () {
		const db = yield* Database;
		const config = yield* Config;

		const userStore = new DatabaseUserStore({ client: db });
		yield* userStore.ready;
		const userSettings = yield* createUserSettingsStore(config, db);
		yield* userSettings.ready;
		const authSessions = new DatabaseAuthSessionStore({ client: db });
		yield* authSessions.ready;
		const sessionStore = new DatabaseSessionStore({
			client: db,
			maxSessionsPerWorkspace: config.maxSessionsPerWorkspace,
		});
		yield* sessionStore.ready;
		// The stores have opened the file; tighten its permissions after SQLite
		// creates it. The containing directory is also private.
		if (config.database.kind === "local" && config.database.path !== ":memory:") {
			try {
				chmodSync(config.database.path, 0o600);
			} catch {
				// Best effort on platforms/filesystems without POSIX permissions.
			}
		}

		return Context.empty()
			.pipe(Context.add(UserStore, userStore))
			.pipe(Context.add(UserSettings, userSettings))
			.pipe(Context.add(AuthSessions, authSessions))
			.pipe(Context.add(SessionStore, sessionStore));
	}),
);

/**
 * Builds the per-user settings store for the configured backend. The file
 * backend (the default) keeps API keys on the server host. The database
 * backend encrypts them at rest under the configured master key.
 */
function createUserSettingsStore(
	config: ServerConfig,
	db: DatabaseClient,
): Effect.Effect<UserSettingsStore, StoreError> {
	return Effect.gen(function* () {
		const cipher = yield* storeEffect(async () => {
			const masterKey =
				(await loadMasterKey({ key: config.secretKey, file: config.secretKeyFile })) ??
				loadOrCreateLocalMasterKey(config.dataDir);
			return await createSecretCipher(masterKey);
		});
		if (config.settingsStore === "database") {
			return new DatabaseUserSettingsStore({
				client: db,
				cipher,
			});
		}
		return new FileUserSettingsStore({ dir: join(config.dataDir, "settings"), cipher });
	});
}

/** Per-session durable workspaces, mounted into the project box pool. */
const workspacesLayer = Layer.effect(
	Workspaces,
	Effect.gen(function* () {
		const config = yield* Config;
		return createWorkspaceManager(config.box.workspaceRoot);
	}),
);

/**
 * The per-process RunManager. Each run resolves a selection (the thread's
 * override or the account default), loads the credential for that preset, and
 * refreshes an expired subscription token before building the provider.
 */
const runsLayer = Layer.effect(
	Runs,
	Effect.gen(function* () {
		const config = yield* Config;
		const userSettings = yield* UserSettings;
		const boxes = yield* Boxes;
		const workspaces = yield* Workspaces;
		/** Coalesce refreshes so concurrent runs rotate one refresh token once. */
		const refreshes = new Map<string, Promise<OAuthCredential>>();
		const refreshCredential = (
			key: string,
			provider: "anthropic" | "openai",
			credential: OAuthCredential,
		): Promise<OAuthCredential> => {
			const existing = refreshes.get(key);
			if (existing) return existing;
			const pending = refreshOAuthCredential(provider, credential).finally(() => {
				refreshes.delete(key);
			});
			refreshes.set(key, pending);
			return pending;
		};
		const llmFor = (ownerId: string, override: LlmModelSelection | null) =>
			Effect.gen(function* () {
				const status = yield* userSettings.getLlmStatus(ownerId);
				const selection = override
					? {
							preset: override.preset,
							provider: null,
							baseURL: null,
							model: override.model,
							contextTokens: override.contextTokens ?? null,
						}
					: status.settings;
				let credential = yield* userSettings.getCredential(ownerId, selection.preset);
				const oauthProvider = getLlmPreset(selection.preset)?.oauth?.provider;
				if (credential?.kind === "oauth" && oauthProvider && credentialExpired(credential)) {
					const expired = credential;
					const key = `${ownerId}:${selection.preset}`;
					credential = yield* Effect.tryPromise({
						try: () => refreshCredential(key, oauthProvider, expired),
						catch: toStoreError,
					}).pipe(
						Effect.tap((refreshed) => userSettings.setCredential(ownerId, selection.preset, refreshed)),
						// A failed refresh must not be silent: the provider call will
						// then fail with an opaque 401. Log it so the operator can tell
						// "the subscription sign-in expired" apart from a provider bug.
						Effect.catchCause((cause) =>
							Effect.sync(() => {
								console.warn(
									`relay llm: could not refresh the "${selection.preset}" subscription token ` +
										`for ${ownerId}; runs will fail until it is reconnected in Settings: ${causeMessage(cause)}`,
								);
								return expired;
							}),
						),
					);
				}
				return createRunLlm(config, { selection, credential });
			});
		return new RunManager({ config, llmFor, boxes, workspaces });
	}),
);

/** The stable identity local mode uses for every request. */
function localIdentity(): AuthIdentity {
	let name: string | undefined;
	try {
		name = userInfo().username;
	} catch {
		// Some containers do not expose user info; the fallback is still stable.
	}
	return { provider: "local", subject: "local", ...(name ? { name } : {}) };
}

/**
 * Seed and resolve the local user. Resolving through the normal user store
 * creates a real `users` row, so database-backed settings and auth tables keep
 * their foreign keys valid.
 */
function resolveLocalUser(userStore: DatabaseUserStore): Effect.Effect<AuthenticatedUser, StoreError> {
	return Effect.gen(function* () {
		const identity = localIdentity();
		const user = yield* userStore.resolve(identity);
		const name = user.name ?? identity.name;
		return {
			...user,
			provider: "local",
			...(name ? { name } : {}),
		};
	});
}

/**
 * The full server environment. The `provideMerge` chains keep acquisition
 * sequential (config → database → stores → boxes → runs) and keep every layer's
 * output available to consumers downstream.
 */
export const serverLayer = (config: ServerConfig) => {
	const base = databaseLayer.pipe(Layer.provideMerge(configLayer(config)));
	const stores = storesLayer.pipe(Layer.provideMerge(base));
	const boxes = boxesLayer(config.box).pipe(Layer.provideMerge(stores));
	const workspaces = workspacesLayer.pipe(Layer.provideMerge(boxes));
	return runsLayer.pipe(Layer.provideMerge(workspaces));
};

/**
 * Materializes the {@link ServerServices} bundle once for the process;
 * `main.ts` composes it into the HTTP application.
 */
export async function createServices(config: ServerConfig): Promise<ServerServices> {
	return await Effect.runPromise(
		Effect.gen(function* () {
			const serverConfig = yield* Config;
			const db = yield* Database;
			const userStore = yield* UserStore;
			const userSettings = yield* UserSettings;
			const authSessions = yield* AuthSessions;
			const sessionStore = yield* SessionStore;
			const runs = yield* Runs;
			const workspaces = yield* Workspaces;
			const boxes = yield* Boxes;
			// Pruning happens inside the session store's write batch; drop the
			// affected session workspaces asynchronously. A session with an
			// active run is never removed.
			sessionStore.onPruned = (sessionIds) => {
				const removable = new Set(sessionIds.filter((sessionId) => !runs.isRunning(sessionId)));
				if (removable.size > 0) {
					void Effect.runPromise(workspaces.removeSessions(removable)).catch((error: unknown) => {
						console.warn("relay workspace: could not remove pruned sessions:", error);
					});
				}
			};
			const localUser = serverConfig.authMode === "local" ? yield* resolveLocalUser(userStore) : null;
			return {
				config: serverConfig,
				db,
				userStore,
				userSettings,
				authSessions,
				sessionStore,
				runs,
				workspaces,
				localUser,
				boxes,
			};
		}).pipe(Effect.provide(serverLayer(config))),
	);
}
