import type { LLMProvider } from "@vvtxn/relay/api/types.ts";
import type { AuthenticatedUser } from "@vvtxn/relay/core/index.ts";
import { authenticate, DatabaseUserStore, LocalAuthProvider } from "@vvtxn/relay/core/index.ts";
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
 * hidden state. If the codebase adopts Effect later, each field becomes a
 * Layer and this function becomes the layer graph.
 */
export interface ServerServices {
	config: ServerConfig;
	db: DatabaseClient;
	user: AuthenticatedUser;
	sessionStore: DatabaseSessionStore;
	provider: LLMProvider;
	runs: RunManager;
}

export async function createServices(config: ServerConfig): Promise<ServerServices> {
	const db = createDatabaseClient({ url: config.tursoUrl, authToken: config.tursoToken });
	const sessionStore = new DatabaseSessionStore({ url: config.tursoUrl, authToken: config.tursoToken, client: db });
	const userStore = new DatabaseUserStore({ url: config.tursoUrl, authToken: config.tursoToken, client: db });
	const user = await authenticate(new LocalAuthProvider(config.devAuthSubject), undefined, userStore);
	const provider = new CompletionsProvider({ apiKey: config.apiKey, baseURL: config.baseURL });
	const runs = new RunManager({ config, sessionStore, provider });
	return { config, db, user, sessionStore, provider, runs };
}
