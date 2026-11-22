/**
 * Local-file per-user settings — the default backend. Secrets never reach the
 * database: each user gets one JSON document under `dir` holding encrypted
 * credentials plus non-sensitive metadata (selection, hint, timestamp), written
 * mode `0600` via a temp file and rename so readers never observe a partial
 * document.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Effect } from "effect";
import type { ProviderKind } from "#/api/types.ts";
import { storeEffect, type StoreError } from "../effect.ts";
import { DEFAULT_PRESET_ID } from "../llm-presets.ts";
import { isEnoent, type SecretCipher, userSettingsAad } from "./secret.ts";
import {
	apiKeyHint,
	buildLlmStatus,
	credentialStatusFrom,
	effectiveKeyPreset,
	parseCredentialPayload,
	parseCredentialRecords,
	type CredentialStatus,
	type LlmCredential,
	type StoredCredentialRecord,
	type UserLlmPatch,
	type UserLlmRecord,
	type UserLlmSettings,
	type UserLlmStatus,
	type UserSettingsStore,
} from "./settings.ts";

export interface FileUserSettingsStoreOptions {
	/** Directory holding one `<userId>.json` document per user. */
	dir: string;
	/** Encrypts keys at rest; constructed from the server's master key. */
	cipher: SecretCipher;
}

/** The selection as persisted; every field is optional so old files upgrade. */
interface StoredLlm {
	preset?: string;
	provider?: string;
	baseURL?: string;
	model?: string;
	contextTokens?: number;
}

/** On-disk document shape; only credential payloads are encrypted. */
interface StoredSettings {
	apiKey?: string;
	hint?: string;
	keyPreset?: string;
	credentials?: Record<string, StoredCredentialRecord>;
	llm?: StoredLlm;
	updatedAt?: string;
}

/** User ids are server-generated UUIDs; anything else never reaches the fs. */
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class FileUserSettingsStore implements UserSettingsStore {
	private readonly dir: string;
	private readonly cipher: SecretCipher;
	private readonly dirReady: Promise<void>;

	constructor(options: FileUserSettingsStoreOptions) {
		this.dir = options.dir;
		this.cipher = options.cipher;
		this.dirReady = this.initialize();
	}

	/** Resolves once the store's directory has been created. */
	get ready(): Effect.Effect<void, StoreError> {
		return storeEffect(() => this.dirReady);
	}

	getLlm(userId: string): Effect.Effect<UserLlmRecord, StoreError> {
		return storeEffect(async () => {
			await this.dirReady;
			const stored = await this.read(userId);
			const settings = parseStoredLlm(stored?.llm);
			const credential = await this.credentialFromStored(userId, stored, settings.preset);
			return {
				settings,
				keyPreset: credential ? settings.preset : null,
				apiKey: credential?.kind === "api-key" ? credential.apiKey : null,
			};
		});
	}

	getLlmStatus(userId: string): Effect.Effect<UserLlmStatus, StoreError> {
		return storeEffect(async () => {
			await this.dirReady;
			const stored = await this.read(userId);
			const settings = parseStoredLlm(stored?.llm);
			const record = stored?.credentials?.[settings.preset];
			if (record) return { settings, keyPreset: settings.preset, keySet: true, hint: record.hint };
			return buildLlmStatus({
				hasKey: Boolean(stored?.apiKey),
				keyPreset: stored?.keyPreset ?? null,
				hint: stored?.hint ?? null,
				settings,
			});
		});
	}

	getCredential(userId: string, preset: string): Effect.Effect<LlmCredential | null, StoreError> {
		return storeEffect(async () => {
			await this.dirReady;
			const stored = await this.read(userId);
			return await this.credentialFromStored(userId, stored, preset);
		});
	}

	setCredential(userId: string, preset: string, credential: LlmCredential | null): Effect.Effect<void, StoreError> {
		return storeEffect(async () => {
			await this.dirReady;
			const stored = await this.read(userId);
			const next = { ...(stored ?? {}) };
			const credentials = { ...(next.credentials ?? {}) };
			if (credential) credentials[preset] = await this.encryptCredential(userId, credential);
			else delete credentials[preset];
			if (Object.keys(credentials).length > 0) next.credentials = credentials;
			else delete next.credentials;
			// Keep the legacy single-key fields coherent when the changed preset
			// is the one they belong to.
			const legacyPreset = next.apiKey ? effectiveKeyPreset(next.keyPreset ?? null) : null;
			if (legacyPreset === preset) {
				const record = credentials[preset];
				if (record) {
					if (record.hint) next.hint = record.hint;
					else delete next.hint;
				} else {
					delete next.apiKey;
					delete next.hint;
					delete next.keyPreset;
				}
			}
			await this.write(userId, next);
		});
	}

	listCredentials(userId: string): Effect.Effect<CredentialStatus[], StoreError> {
		return storeEffect(async () => {
			await this.dirReady;
			const stored = await this.read(userId);
			const credentials = stored?.credentials ?? {};
			const statuses = Object.entries(credentials).map(([preset, record]) =>
				credentialStatusFrom(preset, record),
			);
			if (stored?.apiKey) {
				const preset = effectiveKeyPreset(stored.keyPreset ?? null);
				if (!credentials[preset]) {
					statuses.push({
						preset,
						kind: "api-key",
						hint: stored.hint ?? null,
						expiresAt: null,
						accountId: null,
					});
				}
			}
			return statuses;
		});
	}

	setLlm(userId: string, patch: UserLlmPatch): Effect.Effect<void, StoreError> {
		return storeEffect(async () => {
			await this.dirReady;
			const stored = await this.read(userId);
			const current = parseStoredLlm(stored?.llm);
			const credentials = { ...(stored?.credentials ?? {}) };

			let apiKey = stored?.apiKey ?? null;
			let hint = stored?.hint ?? null;
			let keyPreset = stored?.apiKey ? effectiveKeyPreset(stored.keyPreset ?? null) : null;

			if (patch.apiKey !== undefined) {
				if (patch.apiKey === null) {
					delete credentials[patch.preset];
					if (keyPreset === patch.preset) {
						apiKey = null;
						hint = null;
						keyPreset = null;
					}
				} else {
					const record = await this.encryptCredential(userId, { kind: "api-key", apiKey: patch.apiKey });
					credentials[patch.preset] = record;
					apiKey = record.secret;
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

			await this.write(userId, {
				...(apiKey ? { apiKey } : {}),
				...(hint ? { hint } : {}),
				...(keyPreset ? { keyPreset } : {}),
				...(Object.keys(credentials).length > 0 ? { credentials } : {}),
				llm: {
					preset: settings.preset,
					...(settings.provider ? { provider: settings.provider } : {}),
					...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
					...(settings.model ? { model: settings.model } : {}),
					...(settings.contextTokens ? { contextTokens: settings.contextTokens } : {}),
				},
				updatedAt: new Date().toISOString(),
			});
		});
	}

	/** Decrypts one preset's credential, falling back to a legacy single key. */
	private async credentialFromStored(
		userId: string,
		stored: StoredSettings | null,
		preset: string,
	): Promise<LlmCredential | null> {
		const record = stored?.credentials?.[preset];
		if (record) {
			const raw = await this.cipher.decrypt(record.secret, userSettingsAad(userId));
			return parseCredentialPayload(raw, record.kind);
		}
		if (!stored?.apiKey) return null;
		if (effectiveKeyPreset(stored.keyPreset ?? null) !== preset) return null;
		return {
			kind: "api-key",
			apiKey: await this.cipher.decrypt(stored.apiKey, userSettingsAad(userId)),
		};
	}

	private async encryptCredential(userId: string, credential: LlmCredential): Promise<StoredCredentialRecord> {
		return {
			kind: credential.kind,
			secret: await this.cipher.encrypt(JSON.stringify(credential), userSettingsAad(userId)),
			hint:
				credential.kind === "api-key"
					? apiKeyHint(credential.apiKey)
					: (credential.accountId ?? "subscription"),
			expiresAt: credential.kind === "oauth" ? credential.expiresAt : null,
			accountId: credential.kind === "oauth" ? credential.accountId : null,
			updatedAt: new Date().toISOString(),
		};
	}

	private pathFor(userId: string): string {
		if (!USER_ID_PATTERN.test(userId)) throw new Error(`Invalid user id for settings file: "${userId}"`);
		return join(this.dir, `${userId}.json`);
	}

	private async read(userId: string): Promise<StoredSettings | null> {
		const path = this.pathFor(userId);
		let raw: string;
		try {
			raw = await readFile(path, "utf8");
		} catch (error) {
			if (isEnoent(error)) return null;
			throw error;
		}
		let parsed: Partial<StoredSettings>;
		try {
			parsed = JSON.parse(raw) as Partial<StoredSettings>;
		} catch {
			throw new Error(`Settings file for ${userId} is not valid JSON`);
		}
		return {
			...(typeof parsed.apiKey === "string" && parsed.apiKey.length > 0 ? { apiKey: parsed.apiKey } : {}),
			...(typeof parsed.hint === "string" ? { hint: parsed.hint } : {}),
			...(typeof parsed.keyPreset === "string" ? { keyPreset: parsed.keyPreset } : {}),
			...(parsed.credentials ? { credentials: parseCredentialRecords(parsed.credentials) } : {}),
			...(parsed.llm && typeof parsed.llm === "object" ? { llm: parsed.llm } : {}),
			...(typeof parsed.updatedAt === "string" ? { updatedAt: parsed.updatedAt } : {}),
		};
	}

	private async write(userId: string, next: StoredSettings): Promise<void> {
		const path = this.pathFor(userId);
		const tmp = `${path}.${process.pid}.tmp`;
		try {
			await writeFile(tmp, `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 });
			await rename(tmp, path);
		} catch (error) {
			await rm(tmp, { force: true }).catch(() => {});
			throw error;
		}
	}

	private async initialize(): Promise<void> {
		await mkdir(this.dir, { recursive: true, mode: 0o700 });
	}
}

function parseStoredLlm(llm: StoredLlm | undefined): UserLlmSettings {
	const provider: ProviderKind | null =
		llm?.provider === "openai" || llm?.provider === "anthropic" ? llm.provider : null;
	return {
		preset: typeof llm?.preset === "string" && llm.preset ? llm.preset : DEFAULT_PRESET_ID,
		provider,
		baseURL: typeof llm?.baseURL === "string" && llm.baseURL ? llm.baseURL : null,
		model: typeof llm?.model === "string" && llm.model ? llm.model : null,
		contextTokens: typeof llm?.contextTokens === "number" && llm.contextTokens > 0 ? llm.contextTokens : null,
	};
}
