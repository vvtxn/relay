import { Context, Effect, Layer } from "effect";
import { chmodSync, mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { BoxManager } from "@vvtxn/box/types.ts";
import { Boxes, boxesLayer } from "@vvtxn/box/service.ts";
import type { AuthenticatedUser, AuthIdentity } from "@vvtxn/relay/core/index.ts";
import {
	createSecretCipher,
	DatabaseAuthSessionStore,
	DatabaseUserSettingsStore,
	DatabaseUserStore,
	FileUserSettingsStore,
	loadMasterKey,
	loadOrCreateLocalMasterKey,
	migrateApiKeysToFile,
	type UserSettingsStore,
} from "@vvtxn/relay/core/index.ts";
import { CompletionsProvider } from "@vvtxn/relay/api/providers/completions.ts";
import { createDatabaseClient, type DatabaseClient } from "@vvtxn/relay/core/database.ts";
import { storeEffect, type StoreError } from "@vvtxn/relay/core/effect.ts";
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
	userSettings: UserSettingsStore;
	authSessions: DatabaseAuthSessionStore;
	sessionStore: DatabaseSessionStore;
	runs: RunManager;
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
 * backend (the default) keeps API keys on the server host and migrates any
 * keys already stored in the database, clearing the cloud columns. The
 * database backend encrypts them at rest under the configured master key.
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
		const databaseStore = () =>
			new DatabaseUserSettingsStore({
				client: db,
				cipher,
			});
		if (config.settingsStore === "database") return databaseStore();

		const fileStore = new FileUserSettingsStore({ dir: join(config.dataDir, "settings"), cipher });
		// Local databases never held cloud keys; only migrate when the database
		// is remote (the previous default).
		if (config.database.kind === "turso") {
			const migration = yield* migrateApiKeysToFile(databaseStore(), fileStore);
			if (migration.migrated > 0) {
				console.log(`Migrated ${migration.migrated} API key(s) out of the database into ${config.dataDir}`);
			}
			if (migration.failed > 0) {
				console.error(
					`Failed to migrate ${migration.failed} API key(s); they remain in the database. ` +
						`Set the previous RELAY_SECRET_KEY to recover them.`,
				);
			}
		}
		return fileStore;
	});
}

/**
 * The per-process RunManager. Each run builds a provider from the owning
 * user's stored key: the key is per-user, decrypted on demand, and never
 * enters the model's context.
 */
const runsLayer = Layer.effect(
	Runs,
	Effect.gen(function* () {
		const config = yield* Config;
		const userSettings = yield* UserSettings;
		const boxes = yield* Boxes;
		const providerFor = (ownerId: string) =>
			Effect.gen(function* () {
				const apiKey = yield* userSettings.getApiKey(ownerId);
				return apiKey ? new CompletionsProvider({ apiKey, baseURL: config.baseURL }) : null;
			});
		return new RunManager({ config, providerFor, boxes });
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
	return runsLayer.pipe(Layer.provideMerge(boxes));
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
			const boxes = yield* Boxes;
			const localUser = serverConfig.authMode === "local" ? yield* resolveLocalUser(userStore) : null;
			return {
				config: serverConfig,
				db,
				userStore,
				userSettings,
				authSessions,
				sessionStore,
				runs,
				localUser,
				boxes,
			};
		}).pipe(Effect.provide(serverLayer(config))),
	);
}
