import type { Effect } from "effect";
import type { DatabaseClient } from "../database.ts";
import { storeEffect, type StoreError } from "../effect.ts";
import { type SecretCipher, userSettingsAad } from "./secret.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_settings (
	user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	llm_api_key TEXT,
	llm_api_key_hint TEXT,
	updated_at TEXT NOT NULL
);
`;

/** API-key metadata safe to return to clients: presence plus a masked hint. */
export interface UserSettingsStatus {
	set: boolean;
	hint: string | null;
}

/**
 * Per-user settings. `getApiKey` is the only plaintext path: the key is
 * encrypted at rest and never returned to clients — reads expose only whether
 * a key is set plus a short masked hint, which must not require decryption.
 */
export interface UserSettingsStore {
	/** Resolves once the store is ready to serve reads and writes. */
	readonly ready: Effect.Effect<void, StoreError>;
	/** The user's LLM API key, or null when none is configured. */
	getApiKey(userId: string): Effect.Effect<string | null, StoreError>;
	/** Whether a key is set and its masked hint (no decryption). */
	getApiKeyStatus(userId: string): Effect.Effect<UserSettingsStatus, StoreError>;
	/** Set (or, with null, clear) the user's LLM API key. */
	setApiKey(userId: string, apiKey: string | null): Effect.Effect<void, StoreError>;
}

/** Last 4 characters only — enough to recognize a key without leaking it. */
export function apiKeyHint(apiKey: string): string {
	return apiKey.length <= 4 ? "•" : apiKey.slice(-4);
}

export interface DatabaseUserSettingsStoreOptions {
	client: DatabaseClient;
	/** Encrypts keys at rest; constructed from the server's master key. */
	cipher: SecretCipher;
}

/**
 * Database-backed per-user settings. The LLM API key is stored encrypted
 * (AES-GCM, owner-bound AAD) because the database may be remote: a leaked
 * database or database token yields ciphertext only.
 */
export class DatabaseUserSettingsStore implements UserSettingsStore {
	private readonly client: DatabaseClient;
	private readonly cipher: SecretCipher;
	private readonly schemaReady: Promise<void>;

	constructor(options: DatabaseUserSettingsStoreOptions) {
		this.client = options.client;
		this.cipher = options.cipher;
		this.schemaReady = this.initialize();
	}

	/** Resolves once the store's schema has been initialized. */
	get ready(): Effect.Effect<void, StoreError> {
		return storeEffect(() => this.schemaReady);
	}

	getApiKey(userId: string): Effect.Effect<string | null, StoreError> {
		return storeEffect(() => this.getApiKeyPromise(userId));
	}

	private async getApiKeyPromise(userId: string): Promise<string | null> {
		await this.schemaReady;
		const result = (await this.client.execute({
			sql: "SELECT llm_api_key FROM user_settings WHERE user_id = ?",
			args: [userId],
		})) as unknown as { rows: Record<string, unknown>[] };
		const value = result.rows[0]?.llm_api_key;
		if (typeof value !== "string" || value.length === 0) return null;
		return await this.cipher.decrypt(value, userSettingsAad(userId));
	}

	getApiKeyStatus(userId: string): Effect.Effect<UserSettingsStatus, StoreError> {
		return storeEffect(() => this.getApiKeyStatusPromise(userId));
	}

	private async getApiKeyStatusPromise(userId: string): Promise<UserSettingsStatus> {
		await this.schemaReady;
		const result = (await this.client.execute({
			sql: "SELECT llm_api_key, llm_api_key_hint FROM user_settings WHERE user_id = ?",
			args: [userId],
		})) as unknown as { rows: Record<string, unknown>[] };
		const row = result.rows[0];
		const value = row?.llm_api_key;
		if (typeof value !== "string" || value.length === 0) return { set: false, hint: null };
		const hint = row?.llm_api_key_hint;
		return { set: true, hint: typeof hint === "string" && hint.length > 0 ? hint : null };
	}

	setApiKey(userId: string, apiKey: string | null): Effect.Effect<void, StoreError> {
		return storeEffect(() => this.setApiKeyPromise(userId, apiKey));
	}

	private async setApiKeyPromise(userId: string, apiKey: string | null): Promise<void> {
		await this.schemaReady;
		// Upsert rather than delete so future per-user settings columns survive
		// clearing the key.
		const encrypted = apiKey === null ? null : await this.cipher.encrypt(apiKey, userSettingsAad(userId));
		const hint = apiKey === null ? null : apiKeyHint(apiKey);
		await this.client.execute({
			sql: `INSERT INTO user_settings (user_id, llm_api_key, llm_api_key_hint, updated_at) VALUES (?, ?, ?, ?)
				ON CONFLICT(user_id) DO UPDATE SET llm_api_key = excluded.llm_api_key,
					llm_api_key_hint = excluded.llm_api_key_hint, updated_at = excluded.updated_at`,
			args: [userId, encrypted, hint, new Date().toISOString()],
		});
	}

	private async initialize(): Promise<void> {
		for (const sql of SCHEMA.split(";")
			.map((part) => part.trim())
			.filter(Boolean)) {
			await this.client.execute(sql);
		}
		await this.ensureHintColumn();
	}

	/** Adds the hint column to tables created before it existed. */
	private async ensureHintColumn(): Promise<void> {
		let hasHint = false;
		try {
			const info = (await this.client.execute("PRAGMA table_info(user_settings)")) as unknown as {
				rows: Record<string, unknown>[];
			};
			hasHint = info.rows.some((row) => row["name"] === "llm_api_key_hint");
		} catch {
			// Driver-specific PRAGMA support: fall through to the ALTER, which
			// reports a duplicate-column error when the column is already there.
		}
		if (hasHint) return;
		try {
			await this.client.execute("ALTER TABLE user_settings ADD COLUMN llm_api_key_hint TEXT");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!/duplicate column/i.test(message)) throw error;
		}
	}
}
