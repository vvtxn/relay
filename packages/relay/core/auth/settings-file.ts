/**
 * Local-file per-user settings — the default backend. Secrets never reach the
 * database: each user gets one JSON document under `dir` holding the encrypted
 * API key plus non-sensitive metadata (hint, timestamp), written mode `0600`
 * via a temp file and rename so readers never observe a partial document.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Effect } from "effect";
import { storeEffect, type StoreError } from "../effect.ts";
import { isEncryptedSecret, isEnoent, type SecretCipher, userSettingsAad } from "./secret.ts";
import { apiKeyHint, type UserSettingsStatus, type UserSettingsStore } from "./settings.ts";

export interface FileUserSettingsStoreOptions {
	/** Directory holding one `<userId>.json` document per user. */
	dir: string;
	/** Encrypts keys at rest; constructed from the master key. */
	cipher: SecretCipher;
}

/** On-disk document shape; only `apiKey` is encrypted. */
interface StoredSettings {
	apiKey: string;
	hint: string;
	updatedAt: string;
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

	getApiKey(userId: string): Effect.Effect<string | null, StoreError> {
		return storeEffect(async () => {
			await this.dirReady;
			const stored = await this.read(userId);
			if (!stored) return null;
			if (!isEncryptedSecret(stored.apiKey)) {
				throw new Error("Stored API key is not encrypted; re-enter it in Settings.");
			}
			return await this.cipher.decrypt(stored.apiKey, userSettingsAad(userId));
		});
	}

	getApiKeyStatus(userId: string): Effect.Effect<UserSettingsStatus, StoreError> {
		return storeEffect(async () => {
			await this.dirReady;
			const stored = await this.read(userId);
			if (!stored) return { set: false, hint: null };
			return { set: true, hint: stored.hint.length > 0 ? stored.hint : null };
		});
	}

	setApiKey(userId: string, apiKey: string | null): Effect.Effect<void, StoreError> {
		return storeEffect(async () => {
			await this.dirReady;
			const path = this.pathFor(userId);
			if (apiKey === null) {
				await rm(path, { force: true });
				return;
			}
			const stored: StoredSettings = {
				apiKey: await this.cipher.encrypt(apiKey, userSettingsAad(userId)),
				hint: apiKeyHint(apiKey),
				updatedAt: new Date().toISOString(),
			};
			const tmp = `${path}.${process.pid}.tmp`;
			try {
				await writeFile(tmp, `${JSON.stringify(stored, null, "\t")}\n`, { mode: 0o600 });
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
		if (typeof parsed.apiKey !== "string" || parsed.apiKey.length === 0) {
			throw new Error(`Settings file for ${userId} has no API key`);
		}
		return {
			apiKey: parsed.apiKey,
			hint: typeof parsed.hint === "string" ? parsed.hint : "",
			updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
		};
	}

	private async initialize(): Promise<void> {
		await mkdir(this.dir, { recursive: true, mode: 0o700 });
	}
}
