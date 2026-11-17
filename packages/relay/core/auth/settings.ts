import type { Effect } from "effect";
import type { ProviderKind } from "#/api/types.ts";
import type { DatabaseClient } from "../database.ts";
import { storeEffect, type StoreError } from "../effect.ts";
import { DEFAULT_PRESET_ID } from "../llm-presets.ts";
import { type SecretCipher, userSettingsAad } from "./secret.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_settings (
	user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	llm_api_key TEXT,
	llm_api_key_hint TEXT,
	llm_preset TEXT,
	llm_provider TEXT,
	llm_base_url TEXT,
	llm_model TEXT,
	llm_context_tokens INTEGER,
	llm_key_preset TEXT,
	updated_at TEXT NOT NULL
);
`;

/** Columns added after the original table; applied with ALTER for old databases. */
const ADDED_COLUMNS: ReadonlyArray<readonly [name: string, type: string]> = [
	["llm_api_key_hint", "TEXT"],
	["llm_preset", "TEXT"],
	["llm_provider", "TEXT"],
	["llm_base_url", "TEXT"],
	["llm_model", "TEXT"],
	["llm_context_tokens", "INTEGER"],
	["llm_key_preset", "TEXT"],
];

/** The per-user LLM selection. Provider-independent: presets imply a provider
 * and base URL, while `custom` stores them explicitly. */
export interface UserLlmSettings {
	preset: string;
	provider: ProviderKind | null;
	baseURL: string | null;
	model: string | null;
	contextTokens: number | null;
}

export const DEFAULT_USER_LLM_SETTINGS: UserLlmSettings = {
	preset: DEFAULT_PRESET_ID,
	provider: null,
	baseURL: null,
	model: null,
	contextTokens: null,
};

/** A stored selection plus the decrypted key (only returned by {@link UserSettingsStore.getLlm}). */
export interface UserLlmRecord {
	settings: UserLlmSettings;
	/** Preset the stored key belongs to; `null` when no key is stored. */
	keyPreset: string | null;
	apiKey: string | null;
}

/** A stored selection plus key metadata (no decryption). */
export interface UserLlmStatus {
	settings: UserLlmSettings;
	/** Preset the stored key belongs to; `null` when no key is stored. */
	keyPreset: string | null;
	/** True when a key is stored *for the selected preset*. */
	keySet: boolean;
	hint: string | null;
}

/** Fields accepted by {@link UserSettingsStore.setLlm}. Omitted fields are preserved. */
export interface UserLlmPatch {
	preset: string;
	provider?: ProviderKind | null;
	baseURL?: string | null;
	model?: string | null;
	contextTokens?: number | null;
	/**
	 * `undefined` keeps the stored key (cleared automatically if the preset
	 * changed), `null` clears it, a string replaces it.
	 */
	apiKey?: string | null;
}

/**
 * Per-user settings. The API key is encrypted at rest and never returned to
 * clients — status reads expose only whether a key is set plus a short masked
 * hint, which must not require decryption.
 */
export interface UserSettingsStore {
	/** Resolves once the store is ready to serve reads and writes. */
	readonly ready: Effect.Effect<void, StoreError>;
	/** The user's selection and decrypted key, for building a provider. */
	getLlm(userId: string): Effect.Effect<UserLlmRecord, StoreError>;
	/** The user's selection and key metadata, for the settings UI. */
	getLlmStatus(userId: string): Effect.Effect<UserLlmStatus, StoreError>;
	/** Set the user's selection and, optionally, the key for that selection. */
	setLlm(userId: string, patch: UserLlmPatch): Effect.Effect<void, StoreError>;
}

/** Last 4 characters only — enough to recognize a key without leaking it. */
export function apiKeyHint(apiKey: string): string {
	return apiKey.length <= 4 ? "•" : apiKey.slice(-4);
}

/** Legacy keys predate preset binding and belong to the server-default preset. */
export function effectiveKeyPreset(keyPreset: string | null): string {
	return keyPreset ?? DEFAULT_PRESET_ID;
}

function parseProvider(value: unknown): ProviderKind | null {
	return value === "openai" || value === "anthropic" ? value : null;
}

function parseSettingsRow(row: Record<string, unknown> | undefined): UserLlmSettings {
	if (!row) return { ...DEFAULT_USER_LLM_SETTINGS };
	return {
		preset: typeof row.llm_preset === "string" && row.llm_preset ? row.llm_preset : DEFAULT_PRESET_ID,
		provider: parseProvider(row.llm_provider),
		baseURL: typeof row.llm_base_url === "string" && row.llm_base_url ? row.llm_base_url : null,
		model: typeof row.llm_model === "string" && row.llm_model ? row.llm_model : null,
		contextTokens:
			typeof row.llm_context_tokens === "number" && row.llm_context_tokens > 0 ? row.llm_context_tokens : null,
	};
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

	getLlm(userId: string): Effect.Effect<UserLlmRecord, StoreError> {
		return storeEffect(async () => {
			await this.schemaReady;
			const row = await this.readRow(userId);
			const settings = parseSettingsRow(row);
			const stored = typeof row?.llm_api_key === "string" && row.llm_api_key.length > 0 ? row.llm_api_key : null;
			return {
				settings,
				keyPreset: stored ? effectiveKeyPreset(asString(row?.llm_key_preset)) : null,
				apiKey: stored ? await this.cipher.decrypt(stored, userSettingsAad(userId)) : null,
			};
		});
	}

	getLlmStatus(userId: string): Effect.Effect<UserLlmStatus, StoreError> {
		return storeEffect(async () => {
			await this.schemaReady;
			const row = await this.readRow(userId);
			const settings = parseSettingsRow(row);
			return statusFromRow(row, settings);
		});
	}

	setLlm(userId: string, patch: UserLlmPatch): Effect.Effect<void, StoreError> {
		return storeEffect(() => this.setLlmPromise(userId, patch));
	}

	private async setLlmPromise(userId: string, patch: UserLlmPatch): Promise<void> {
		await this.schemaReady;
		const row = await this.readRow(userId);
		const current = parseSettingsRow(row);

		// Start from the stored key, then apply the patch/prest-change rules.
		let encrypted = asString(row?.llm_api_key);
		let hint = asString(row?.llm_api_key_hint);
		let keyPreset = encrypted ? effectiveKeyPreset(asString(row?.llm_key_preset)) : null;

		if (patch.apiKey !== undefined) {
			if (patch.apiKey === null) {
				encrypted = null;
				hint = null;
				keyPreset = null;
			} else {
				encrypted = await this.cipher.encrypt(patch.apiKey, userSettingsAad(userId));
				hint = apiKeyHint(patch.apiKey);
				keyPreset = patch.preset;
			}
		} else if (keyPreset !== null && keyPreset !== patch.preset) {
			// Never reuse a credential against a different provider.
			encrypted = null;
			hint = null;
			keyPreset = null;
		}

		const settings: UserLlmSettings = {
			preset: patch.preset,
			provider: patch.provider !== undefined ? patch.provider : current.provider,
			baseURL: patch.baseURL !== undefined ? patch.baseURL : current.baseURL,
			model: patch.model !== undefined ? patch.model : current.model,
			contextTokens: patch.contextTokens !== undefined ? patch.contextTokens : current.contextTokens,
		};

		await this.client.execute({
			sql: `INSERT INTO user_settings (
					user_id, llm_api_key, llm_api_key_hint, llm_preset, llm_provider, llm_base_url,
					llm_model, llm_context_tokens, llm_key_preset, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(user_id) DO UPDATE SET
					llm_api_key = excluded.llm_api_key,
					llm_api_key_hint = excluded.llm_api_key_hint,
					llm_preset = excluded.llm_preset,
					llm_provider = excluded.llm_provider,
					llm_base_url = excluded.llm_base_url,
					llm_model = excluded.llm_model,
					llm_context_tokens = excluded.llm_context_tokens,
					llm_key_preset = excluded.llm_key_preset,
					updated_at = excluded.updated_at`,
			args: [
				userId,
				encrypted,
				hint,
				settings.preset,
				settings.provider,
				settings.baseURL,
				settings.model,
				settings.contextTokens,
				keyPreset,
				new Date().toISOString(),
			],
		});
	}

	private async readRow(userId: string): Promise<Record<string, unknown> | undefined> {
		const result = (await this.client.execute({
			sql: `SELECT llm_api_key, llm_api_key_hint, llm_preset, llm_provider, llm_base_url,
					llm_model, llm_context_tokens, llm_key_preset
				FROM user_settings WHERE user_id = ?`,
			args: [userId],
		})) as unknown as { rows: Record<string, unknown>[] };
		return result.rows[0];
	}

	private async initialize(): Promise<void> {
		for (const sql of SCHEMA.split(";")
			.map((part) => part.trim())
			.filter(Boolean)) {
			await this.client.execute(sql);
		}
		await this.ensureColumns();
	}

	/** Adds columns introduced after the table was first created. */
	private async ensureColumns(): Promise<void> {
		let existing = new Set<string>();
		try {
			const info = (await this.client.execute("PRAGMA table_info(user_settings)")) as unknown as {
				rows: Record<string, unknown>[];
			};
			existing = new Set(info.rows.map((row) => String(row["name"])));
		} catch {
			// Driver-specific PRAGMA support: fall through to ALTER, which
			// reports a duplicate-column error when the column is already there.
		}
		for (const [name, type] of ADDED_COLUMNS) {
			if (existing.has(name)) continue;
			try {
				await this.client.execute(`ALTER TABLE user_settings ADD COLUMN ${name} ${type}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!/duplicate column/i.test(message)) throw error;
			}
		}
	}
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

export function buildLlmStatus(options: {
	hasKey: boolean;
	keyPreset: string | null;
	hint: string | null;
	settings: UserLlmSettings;
}): UserLlmStatus {
	const keyPreset = options.hasKey ? effectiveKeyPreset(options.keyPreset) : null;
	return {
		settings: options.settings,
		keyPreset,
		keySet: options.hasKey && keyPreset === options.settings.preset,
		hint: options.hasKey ? options.hint : null,
	};
}

export function statusFromRow(row: Record<string, unknown> | undefined, settings: UserLlmSettings): UserLlmStatus {
	const hasKey = typeof row?.llm_api_key === "string" && row.llm_api_key.length > 0;
	return buildLlmStatus({
		hasKey,
		keyPreset: asString(row?.llm_key_preset),
		hint: asString(row?.llm_api_key_hint),
		settings,
	});
}
