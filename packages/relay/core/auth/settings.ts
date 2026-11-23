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
	llm_credentials TEXT,
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
	["llm_credentials", "TEXT"],
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

/** Credential kinds a preset can store. */
export type LlmCredentialKind = "api-key" | "oauth";

export interface ApiKeyCredential {
	kind: "api-key";
	apiKey: string;
}

/** Claude / ChatGPT subscription tokens. */
export interface OAuthCredential {
	kind: "oauth";
	accessToken: string;
	refreshToken: string | null;
	/** Access-token expiry (epoch ms), when the provider reports one. */
	expiresAt: number | null;
	/** ChatGPT account id (from the id token), sent as `chatgpt-account-id`. */
	accountId: string | null;
}

export type LlmCredential = ApiKeyCredential | OAuthCredential;

/** Non-secret credential metadata for the settings UI. */
export interface CredentialStatus {
	preset: string;
	kind: LlmCredentialKind;
	hint: string | null;
	expiresAt: number | null;
	accountId: string | null;
}

/** Human-readable label for a connected account/key. */
export function credentialLabel(credential: LlmCredential): string | null {
	if (credential.kind === "api-key") return apiKeyHint(credential.apiKey);
	return credential.accountId ?? "subscription";
}

/** Persisted credential metadata; `secret` holds the encrypted payload. */
export interface StoredCredentialRecord {
	kind: LlmCredentialKind;
	secret: string;
	hint: string | null;
	expiresAt: number | null;
	accountId: string | null;
	updatedAt: string;
}

export function credentialStatusFrom(preset: string, record: StoredCredentialRecord): CredentialStatus {
	return {
		preset,
		kind: record.kind,
		hint: record.hint,
		expiresAt: record.expiresAt,
		accountId: record.accountId,
	};
}

/** True when an OAuth access token is expired (or about to expire). */
export function credentialExpired(credential: OAuthCredential, now = Date.now()): boolean {
	return credential.expiresAt !== null && credential.expiresAt <= now + 60_000;
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
	/** One preset's decrypted credential (API key or subscription tokens). */
	getCredential(userId: string, preset: string): Effect.Effect<LlmCredential | null, StoreError>;
	/** Store or (with null) remove a preset's credential. */
	setCredential(userId: string, preset: string, credential: LlmCredential | null): Effect.Effect<void, StoreError>;
	/** Non-secret metadata for every connected preset. */
	listCredentials(userId: string): Effect.Effect<CredentialStatus[], StoreError>;
}

/** Last 4 characters only — enough to recognize a key without leaking it. */
export function apiKeyHint(apiKey: string): string {
	return apiKey.length <= 4 ? "•" : apiKey.slice(-4);
}

/**
 * Serializes read-modify-write tasks per key. Both settings backends rewrite a
 * whole document/map on every save, so two concurrent writes for one user (a
 * token refresh racing a Settings save, two subscriptions refreshing together)
 * would otherwise lose one of them.
 */
export function createKeyedSerializer(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
	const tails = new Map<string, Promise<unknown>>();
	return <T>(key: string, task: () => Promise<T>): Promise<T> => {
		const previous = tails.get(key) ?? Promise.resolve();
		// Run the task whether or not the previous one settled successfully.
		const next = previous.then(task, task);
		const tail = next.then(
			() => undefined,
			() => undefined,
		);
		tails.set(key, tail);
		void tail.then(() => {
			if (tails.get(key) === tail) tails.delete(key);
		});
		return next;
	};
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
	/** One settings document per user: serialize read-modify-write saves. */
	private readonly serialize = createKeyedSerializer();

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
			const credential = await this.credentialFromRow(userId, row, settings.preset);
			return {
				settings,
				keyPreset: credential ? settings.preset : null,
				apiKey: credential?.kind === "api-key" ? credential.apiKey : null,
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

	getCredential(userId: string, preset: string): Effect.Effect<LlmCredential | null, StoreError> {
		return storeEffect(async () => {
			await this.schemaReady;
			const row = await this.readRow(userId);
			return await this.credentialFromRow(userId, row, preset);
		});
	}

	setCredential(userId: string, preset: string, credential: LlmCredential | null): Effect.Effect<void, StoreError> {
		return storeEffect(() =>
			this.serialize(userId, async () => {
				await this.schemaReady;
				const row = await this.readRow(userId);
				const credentials = parseCredentialMap(row?.llm_credentials);
				if (credential) credentials[preset] = await this.encryptCredential(userId, credential);
				else delete credentials[preset];
				await this.writeCredentials(userId, credentials, row);
			}),
		);
	}

	listCredentials(userId: string): Effect.Effect<CredentialStatus[], StoreError> {
		return storeEffect(async () => {
			await this.schemaReady;
			const row = await this.readRow(userId);
			const credentials = parseCredentialMap(row?.llm_credentials);
			const statuses = Object.entries(credentials).map(([preset, record]) =>
				credentialStatusFrom(preset, record),
			);
			const legacy = asString(row?.llm_api_key);
			if (legacy) {
				const preset = effectiveKeyPreset(asString(row?.llm_key_preset));
				if (!credentials[preset]) {
					statuses.push({
						preset,
						kind: "api-key",
						hint: asString(row?.llm_api_key_hint),
						expiresAt: null,
						accountId: null,
					});
				}
			}
			return statuses;
		});
	}

	setLlm(userId: string, patch: UserLlmPatch): Effect.Effect<void, StoreError> {
		return storeEffect(() => this.serialize(userId, () => this.setLlmPromise(userId, patch)));
	}

	private async setLlmPromise(userId: string, patch: UserLlmPatch): Promise<void> {
		await this.schemaReady;
		const row = await this.readRow(userId);
		const current = parseSettingsRow(row);
		const credentials = parseCredentialMap(row?.llm_credentials);

		// Legacy single-key columns stay in sync for older clients, while the
		// credentials map is the durable per-preset store.
		let encrypted = asString(row?.llm_api_key);
		let hint = asString(row?.llm_api_key_hint);
		let keyPreset = encrypted ? effectiveKeyPreset(asString(row?.llm_key_preset)) : null;

		if (patch.apiKey !== undefined) {
			if (patch.apiKey === null) {
				delete credentials[patch.preset];
				if (keyPreset === patch.preset) {
					encrypted = null;
					hint = null;
					keyPreset = null;
				}
			} else {
				const record = await this.encryptCredential(userId, { kind: "api-key", apiKey: patch.apiKey });
				credentials[patch.preset] = record;
				encrypted = record.secret;
				hint = record.hint;
				keyPreset = patch.preset;
			}
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
					llm_model, llm_context_tokens, llm_key_preset, llm_credentials, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(user_id) DO UPDATE SET
					llm_api_key = excluded.llm_api_key,
					llm_api_key_hint = excluded.llm_api_key_hint,
					llm_preset = excluded.llm_preset,
					llm_provider = excluded.llm_provider,
					llm_base_url = excluded.llm_base_url,
					llm_model = excluded.llm_model,
					llm_context_tokens = excluded.llm_context_tokens,
					llm_key_preset = excluded.llm_key_preset,
					llm_credentials = excluded.llm_credentials,
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
				Object.keys(credentials).length > 0 ? JSON.stringify(credentials) : null,
				new Date().toISOString(),
			],
		});
	}

	/** Decrypts one preset's credential, falling back to a legacy single key. */
	private async credentialFromRow(
		userId: string,
		row: Record<string, unknown> | undefined,
		preset: string,
	): Promise<LlmCredential | null> {
		const record = parseCredentialMap(row?.llm_credentials)[preset];
		if (record) return await this.decryptCredential(userId, record);
		const legacy = asString(row?.llm_api_key);
		if (!legacy) return null;
		if (effectiveKeyPreset(asString(row?.llm_key_preset)) !== preset) return null;
		return {
			kind: "api-key",
			apiKey: await this.cipher.decrypt(legacy, userSettingsAad(userId)),
		};
	}

	private async encryptCredential(userId: string, credential: LlmCredential): Promise<StoredCredentialRecord> {
		const hint = credentialKindHint(credential);
		return {
			kind: credential.kind,
			secret: await this.cipher.encrypt(JSON.stringify(credential), userSettingsAad(userId)),
			hint,
			expiresAt: credential.kind === "oauth" ? credential.expiresAt : null,
			accountId: credential.kind === "oauth" ? credential.accountId : null,
			updatedAt: new Date().toISOString(),
		};
	}

	private async decryptCredential(userId: string, record: StoredCredentialRecord): Promise<LlmCredential> {
		const raw = await this.cipher.decrypt(record.secret, userSettingsAad(userId));
		return parseCredentialPayload(raw, record.kind);
	}

	private async writeCredentials(
		userId: string,
		credentials: Record<string, StoredCredentialRecord>,
		row: Record<string, unknown> | undefined,
	): Promise<void> {
		const current = parseSettingsRow(row);
		await this.client.execute({
			sql: `INSERT INTO user_settings (user_id, llm_preset, llm_credentials, updated_at)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(user_id) DO UPDATE SET
					llm_credentials = excluded.llm_credentials,
					updated_at = excluded.updated_at`,
			args: [
				userId,
				current.preset,
				Object.keys(credentials).length > 0 ? JSON.stringify(credentials) : null,
				new Date().toISOString(),
			],
		});
	}

	private async readRow(userId: string): Promise<Record<string, unknown> | undefined> {
		const result = (await this.client.execute({
			sql: `SELECT llm_api_key, llm_api_key_hint, llm_preset, llm_provider, llm_base_url,
					llm_model, llm_context_tokens, llm_key_preset, llm_credentials
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
	const record = parseCredentialMap(row?.llm_credentials)[settings.preset];
	if (record) {
		return {
			settings,
			keyPreset: settings.preset,
			keySet: true,
			hint: record.hint,
		};
	}
	const hasKey = typeof row?.llm_api_key === "string" && row.llm_api_key.length > 0;
	return buildLlmStatus({
		hasKey,
		keyPreset: asString(row?.llm_key_preset),
		hint: asString(row?.llm_api_key_hint),
		settings,
	});
}

/** Masked hint for a credential (never the secret itself). */
function credentialKindHint(credential: LlmCredential): string | null {
	if (credential.kind === "api-key") return apiKeyHint(credential.apiKey);
	return credential.accountId ?? "subscription";
}

/** Parses the persisted JSON map of encrypted credentials. */
export function parseCredentialMap(raw: unknown): Record<string, StoredCredentialRecord> {
	if (typeof raw !== "string" || raw.length === 0) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	return parseCredentialRecords(parsed);
}

/** Parses credential records from a decoded JSON object (file backend). */
export function parseCredentialRecords(raw: unknown): Record<string, StoredCredentialRecord> {
	if (typeof raw !== "object" || raw === null) return {};
	const result: Record<string, StoredCredentialRecord> = {};
	for (const [preset, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value !== "object" || value === null) continue;
		const record = value as Record<string, unknown>;
		if (record.kind !== "api-key" && record.kind !== "oauth") continue;
		if (typeof record.secret !== "string" || record.secret.length === 0) continue;
		result[preset] = {
			kind: record.kind,
			secret: record.secret,
			hint: typeof record.hint === "string" ? record.hint : null,
			expiresAt: typeof record.expiresAt === "number" ? record.expiresAt : null,
			accountId: typeof record.accountId === "string" ? record.accountId : null,
			updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
		};
	}
	return result;
}

/** Parses a decrypted credential payload. */
export function parseCredentialPayload(raw: string, kind: LlmCredentialKind): LlmCredential {
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	if (kind === "api-key") {
		if (typeof parsed.apiKey !== "string" || parsed.apiKey.length === 0) {
			throw new Error("Stored API key is malformed; re-enter it in Settings.");
		}
		return { kind: "api-key", apiKey: parsed.apiKey };
	}
	if (typeof parsed.accessToken !== "string" || parsed.accessToken.length === 0) {
		throw new Error("Stored OAuth credential is malformed; reconnect the subscription in Settings.");
	}
	return {
		kind: "oauth",
		accessToken: parsed.accessToken,
		refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : null,
		expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : null,
		accountId: typeof parsed.accountId === "string" ? parsed.accountId : null,
	};
}
