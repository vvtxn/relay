import { Context, Effect, Layer } from "effect";
import type { AuthenticatedUser } from "@vvtxn/relay/core/index.ts";
import { DatabaseAuthSessionStore, DatabaseUserSettingsStore, DatabaseUserStore } from "@vvtxn/relay/core/index.ts";
import { CompletionsProvider } from "@vvtxn/relay/api/providers/completions.ts";
import { createDatabaseClient, type DatabaseClient } from "@vvtxn/relay/core/database.ts";
import { DatabaseSessionStore } from "@vvtxn/relay/core/sessions/index.ts";
import type { ServerConfig } from "./config.ts";
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
	userSettings: DatabaseUserSettingsStore;
	authSessions: DatabaseAuthSessionStore;
	sessionStore: DatabaseSessionStore;
	runs: RunManager;
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
export class UserSettings extends Context.Service<UserSettings, DatabaseUserSettingsStore>()(
	"relay/server/UserSettings",
) {}
export class AuthSessions extends Context.Service<AuthSessions, DatabaseAuthSessionStore>()(
	"relay/server/AuthSessions",
) {}
export class SessionStore extends Context.Service<SessionStore, DatabaseSessionStore>()("relay/server/SessionStore") {}
export class Runs extends Context.Service<Runs, RunManager>()("relay/server/Runs") {}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const configLayer = (config: ServerConfig) => Layer.succeed(Config, config);

/**
 * The shared database client. The Turso client's surface is only `execute` /
 * `batch` (no close), so this layer is unscoped; scope-owned resources arrive
 * with the HTTP server in phase 4.
 */
const databaseLayer = Layer.effect(
	Database,
	Effect.gen(function* () {
		const config = yield* Config;
		return createDatabaseClient({ url: config.tursoUrl, authToken: config.tursoToken });
	}),
);

/**
 * All database stores, acquired in sequence on the shared client: `users`
 * backs the `auth_sessions` foreign key and concurrent DDL is best avoided.
 * Exported so layer tests can drive it with a recording client.
 */
export const storesLayer = Layer.effectContext(
	Effect.gen(function* () {
		const db = yield* Database;
		const config = yield* Config;

		const userStore = new DatabaseUserStore({ url: config.tursoUrl, authToken: config.tursoToken, client: db });
		yield* userStore.ready;
		const userSettings = new DatabaseUserSettingsStore({
			url: config.tursoUrl,
			authToken: config.tursoToken,
			client: db,
		});
		yield* userSettings.ready;
		const authSessions = new DatabaseAuthSessionStore({
			url: config.tursoUrl,
			authToken: config.tursoToken,
			client: db,
		});
		yield* authSessions.ready;
		const sessionStore = new DatabaseSessionStore({
			url: config.tursoUrl,
			authToken: config.tursoToken,
			client: db,
		});
		yield* sessionStore.ready;

		return Context.empty()
			.pipe(Context.add(UserStore, userStore))
			.pipe(Context.add(UserSettings, userSettings))
			.pipe(Context.add(AuthSessions, authSessions))
			.pipe(Context.add(SessionStore, sessionStore));
	}),
);

/**
 * The per-process RunManager. Each run builds a provider from the owning
 * user's stored key: the key is per-user and lives in the database, not in
 * server config.
 */
const runsLayer = Layer.effect(
	Runs,
	Effect.gen(function* () {
		const config = yield* Config;
		const userSettings = yield* UserSettings;
		const providerFor = (ownerId: string) =>
			Effect.gen(function* () {
				const apiKey = yield* userSettings.getApiKey(ownerId);
				return apiKey ? new CompletionsProvider({ apiKey, baseURL: config.baseURL }) : null;
			});
		return new RunManager({ config, providerFor });
	}),
);

/**
 * The full server environment. The `provideMerge` chains keep acquisition
 * sequential (config → database → stores → runs) and keep every layer's
 * output available to consumers downstream.
 */
export const serverLayer = (config: ServerConfig) => {
	const base = databaseLayer.pipe(Layer.provideMerge(configLayer(config)));
	const stores = storesLayer.pipe(Layer.provideMerge(base));
	return runsLayer.pipe(Layer.provideMerge(stores));
};

/**
 * Materializes the {@link ServerServices} bundle for the current
 * (promise-based) handlers. Phase 2+ consumes the tags directly; phase 4
 * replaces this facade with a process runtime owned by `main.ts`.
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
			return { config: serverConfig, db, userStore, userSettings, authSessions, sessionStore, runs };
		}).pipe(Effect.provide(serverLayer(config))),
	);
}
