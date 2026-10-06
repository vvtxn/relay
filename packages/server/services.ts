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
 * This is the composition seam: services are constructed once in
 * `createServices` and passed to handlers explicitly — no module-level
 * hidden state. The authenticated user is resolved per request and added in
 * `RequestServices`, so the same server can host multiple identities.
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

export async function createServices(config: ServerConfig): Promise<ServerServices> {
	const db = createDatabaseClient({ url: config.tursoUrl, authToken: config.tursoToken });

	// Initialize schemas sequentially on the shared client: `users` backs the
	// `auth_sessions` foreign key, and concurrent DDL is best avoided.
	const userStore = new DatabaseUserStore({ url: config.tursoUrl, authToken: config.tursoToken, client: db });
	await userStore.ready;
	const userSettings = new DatabaseUserSettingsStore({
		url: config.tursoUrl,
		authToken: config.tursoToken,
		client: db,
	});
	await userSettings.ready;
	const authSessions = new DatabaseAuthSessionStore({
		url: config.tursoUrl,
		authToken: config.tursoToken,
		client: db,
	});
	await authSessions.ready;
	const sessionStore = new DatabaseSessionStore({ url: config.tursoUrl, authToken: config.tursoToken, client: db });
	await sessionStore.ready;

	// Each run builds a provider from the owning user's stored key: the key is
	// per-user and lives in the database, not in server config.
	const providerFor = async (ownerId: string) => {
		const apiKey = await userSettings.getApiKey(ownerId);
		return apiKey ? new CompletionsProvider({ apiKey, baseURL: config.baseURL }) : null;
	};
	const runs = new RunManager({ config, sessionStore, providerFor });
	return { config, db, userStore, userSettings, authSessions, sessionStore, runs };
}
