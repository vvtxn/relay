/**
 * Local-file per-user settings — the default backend. Secrets never reach the
 * database: each user gets one JSON document under `dir` holding the encrypted
 * API key plus non-sensitive metadata (selection, hint, timestamp), written
 * mode `0600` via a temp file and rename so readers never observe a partial
 * document.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Effect } from "effect";
import type { ProviderKind } from "#/api/types.ts";
import { storeEffect, type StoreError } from "../effect.ts";
import { DEFAULT_PRESET_ID } from "../llm-presets.ts";
import { isEncryptedSecret, isEnoent, type SecretCipher, userSettingsAad } from "./secret.ts";
import {
	apiKeyHint,
	buildLlmStatus,
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

/** On-disk document shape; only `apiKey` is encrypted. */
interface StoredSettings {
	apiKey?: string;
	hint?: string;
	keyPreset?: string;
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
			if (!stored?.apiKey) return { settings, keyPreset: null, apiKey: null };
			if (!isEncryptedSecret(stored.apiKey)) {
				throw new Error("Stored API key is not encrypted; re-enter it in Settings.");
			}
			return {
				settings,
				keyPreset: stored.keyPreset ?? DEFAULT_PRESET_ID,
				apiKey: await this.cipher.decrypt(stored.apiKey, userSettingsAad(userId)),
			};
		});
	}

	getLlmStatus(userId: string): Effect.Effect<UserLlmStatus, StoreError> {
		return storeEffect(async () => {
			await this.dirReady;
			const stored = await this.read(userId);
			const settings = parseStoredLlm(stored?.llm);
			return buildLlmStatus({
				hasKey: Boolean(stored?.apiKey),
				keyPreset: stored?.keyPreset ?? null,
				hint: stored?.hint ?? null,
				settings,
			});
		});
	}

	setLlm(userId: string, patch: UserLlmPatch): Effect.Effect<void, StoreError> {
		return storeEffect(async () => {
			await this.dirReady;
			const path = this.pathFor(userId);
			const stored = await this.read(userId);
			const current = parseStoredLlm(stored?.llm);

			let apiKey = stored?.apiKey ?? null;
			let hint = stored?.hint ?? null;
			let keyPreset = stored?.apiKey ? (stored.keyPreset ?? DEFAULT_PRESET_ID) : null;

			if (patch.apiKey !== undefined) {
				if (patch.apiKey === null) {
					apiKey = null;
					hint = null;
					keyPreset = null;
				} else {
					apiKey = await this.cipher.encrypt(patch.apiKey, userSettingsAad(userId));
					hint = apiKeyHint(patch.apiKey);
					keyPreset = patch.preset;
				}
			} else if (keyPreset !== null && keyPreset !== patch.preset) {
				// Never reuse a credential against a different provider.
				apiKey = null;
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

			const next: StoredSettings = {
				...(apiKey ? { apiKey } : {}),
				...(hint ? { hint } : {}),
				...(keyPreset ? { keyPreset } : {}),
				llm: {
					preset: settings.preset,
					...(settings.provider ? { provider: settings.provider } : {}),
					...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
					...(settings.model ? { model: settings.model } : {}),
					...(settings.contextTokens ? { contextTokens: settings.contextTokens } : {}),
				},
				updatedAt: new Date().toISOString(),
			};

			const tmp = `${path}.${process.pid}.tmp`;
			try {
				await writeFile(tmp, `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 });
				await rename(tmp, path);
			} catch (error) {
				await rm(tmp, { force: true }).catch(() => {});
				throw error;
			}
		});
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
			...(parsed.llm && typeof parsed.llm === "object" ? { llm: parsed.llm } : {}),
			...(typeof parsed.updatedAt === "string" ? { updatedAt: parsed.updatedAt } : {}),
		};
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
