import { createDatabaseClient, type DatabaseClient, databaseCredentialsFromEnv } from "../database.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_settings (
	user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	llm_api_key TEXT,
	updated_at TEXT NOT NULL
);
`;

export interface DatabaseUserSettingsStoreOptions {
	url: string;
	authToken: string;
	client?: DatabaseClient;
}

/**
 * Per-user settings. The LLM API key is stored in plaintext because the server
 * must present it verbatim as a Bearer token — unlike auth session tokens it
 * cannot be hashed. It is never returned to clients; reads expose only whether
 * a key is set and a short masked hint.
 */
export class DatabaseUserSettingsStore {
	private readonly client: DatabaseClient;
	private readonly schemaReady: Promise<void>;

	constructor(options: DatabaseUserSettingsStoreOptions) {
		this.client = options.client ?? createDatabaseClient({ url: options.url, authToken: options.authToken });
		this.schemaReady = this.initialize();
	}

	/** Resolves once the store's schema has been initialized. */
	get ready(): Promise<void> {
		return this.schemaReady;
	}

	static fromEnv(
		options: Omit<DatabaseUserSettingsStoreOptions, "url" | "authToken" | "client"> = {},
	): DatabaseUserSettingsStore {
		return new DatabaseUserSettingsStore({ ...databaseCredentialsFromEnv(), ...options });
	}

	/** The user's LLM API key, or null when none is configured. */
	async getApiKey(userId: string): Promise<string | null> {
		await this.schemaReady;
		const result = await this.client.execute({
			sql: "SELECT llm_api_key FROM user_settings WHERE user_id = ?",
			args: [userId],
		}) as unknown as { rows: Record<string, unknown>[] };
		const value = result.rows[0]?.llm_api_key;
		return typeof value === "string" && value.length > 0 ? value : null;
	}

	/** Set (or, with null, clear) the user's LLM API key. */
	async setApiKey(userId: string, apiKey: string | null): Promise<void> {
		await this.schemaReady;
		// Upsert rather than delete so future per-user settings columns survive
		// clearing the key.
		await this.client.execute({
			sql: `INSERT INTO user_settings (user_id, llm_api_key, updated_at) VALUES (?, ?, ?)
				ON CONFLICT(user_id) DO UPDATE SET llm_api_key = excluded.llm_api_key, updated_at = excluded.updated_at`,
			args: [userId, apiKey, new Date().toISOString()],
		});
	}

	private async initialize(): Promise<void> {
		for (const sql of SCHEMA.split(";").map((part) => part.trim()).filter(Boolean)) {
			await this.client.execute(sql);
		}
	}
}
