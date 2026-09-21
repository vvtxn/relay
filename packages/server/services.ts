import type { LLMProvider } from "@vvtxn/relay/api/types.ts";
import type { AuthenticatedUser } from "@vvtxn/relay/core/index.ts";
import { DatabaseAuthSessionStore, DatabaseUserStore } from "@vvtxn/relay/core/index.ts";
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
	authSessions: DatabaseAuthSessionStore;
	sessionStore: DatabaseSessionStore;
	provider: LLMProvider;
	runs: RunManager;
}

/** Base services plus the caller resolved for this request. */
export interface RequestServices extends ServerServices {
	user: AuthenticatedUser;
}

export function createServices(config: ServerConfig): ServerServices {
	const db = createDatabaseClient({ url: config.tursoUrl, authToken: config.tursoToken });
	const sessionStore = new DatabaseSessionStore({ url: config.tursoUrl, authToken: config.tursoToken, client: db });
	const userStore = new DatabaseUserStore({ url: config.tursoUrl, authToken: config.tursoToken, client: db });
	const authSessions = new DatabaseAuthSessionStore({
		url: config.tursoUrl,
		authToken: config.tursoToken,
		client: db,
	});
	const provider = new CompletionsProvider({ apiKey: config.apiKey, baseURL: config.baseURL });
	const runs = new RunManager({ config, sessionStore, provider });
	return { config, db, userStore, authSessions, sessionStore, provider, runs };
}
