/**
 * Symmetric encryption for per-user secrets (currently the LLM API key).
 *
 * AES-256-GCM via WebCrypto — the primitive the auth session store already
 * hashes with — under a subkey derived from a 32-byte master key with
 * HKDF-SHA256. Payloads are self-describing (`v1.<iv>.<ciphertext>`, both
 * base64url), so legacy plaintext values stay distinguishable while they are
 * migrated, and the additional authenticated data binds a payload to its owner:
 * a ciphertext copied onto another user (or another file) fails to decrypt.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const VERSION = "v1";
const PREFIX = `${VERSION}.`;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const ALGORITHM = "AES-GCM";
/** Domain separator: subkeys derived from the master key are purpose-scoped. */
const KEY_INFO = "relay:user-settings:v1";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Encrypts/decrypts small strings; the caller supplies owner-binding AAD. */
export interface SecretCipher {
	encrypt(plaintext: string, aad: string): Promise<string>;
	decrypt(payload: string, aad: string): Promise<string>;
}

/** Additional authenticated data binding a stored key to its owning user. */
export function userSettingsAad(userId: string): string {
	return `${KEY_INFO}:${userId}`;
}

/** True for values produced by {@link SecretCipher.encrypt} (vs. legacy plaintext). */
export function isEncryptedSecret(value: string): boolean {
	return value.startsWith(PREFIX);
}

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/**
 * Parses a base64url (or hex) 32-byte master key. Surrounding whitespace —
 * e.g. the trailing newline of a mounted secret file — is ignored.
 */
export function parseMasterKey(raw: string): Uint8Array<ArrayBuffer> {
	const value = raw.trim();
	let bytes: Uint8Array<ArrayBuffer> | null = null;
	if (value.length === KEY_BYTES * 2 && /^[0-9a-f]+$/i.test(value)) {
		bytes = new Uint8Array(KEY_BYTES);
		for (let index = 0; index < KEY_BYTES; index++) {
			bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
		}
	} else {
		try {
			bytes = fromBase64Url(value);
		} catch {
			bytes = null;
		}
	}
	if (!bytes || bytes.length !== KEY_BYTES) {
		throw new Error(`Master key must decode to ${KEY_BYTES} bytes (base64url or hex)`);
	}
	return bytes;
}

/** Derives the settings data key from the master key and returns the cipher. */
export async function createSecretCipher(masterKey: Uint8Array<ArrayBuffer>): Promise<SecretCipher> {
	if (masterKey.length !== KEY_BYTES) {
		throw new Error(`Master key must be ${KEY_BYTES} bytes`);
	}
	const material = await crypto.subtle.importKey("raw", masterKey, "HKDF", false, ["deriveKey"]);
	const key = await crypto.subtle.deriveKey(
		{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: encoder.encode(KEY_INFO) },
		material,
		{ name: ALGORITHM, length: 256 },
		false,
		["encrypt", "decrypt"],
	);

	return {
		async encrypt(plaintext, aad) {
			const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
			const ciphertext = new Uint8Array(
				await crypto.subtle.encrypt(
					{ name: ALGORITHM, iv, additionalData: encoder.encode(aad) },
					key,
					encoder.encode(plaintext),
				),
			);
			return `${PREFIX}${base64Url(iv)}.${base64Url(ciphertext)}`;
		},
		async decrypt(payload, aad) {
			if (!isEncryptedSecret(payload)) throw new Error("Value is not an encrypted secret");
			const parts = payload.slice(PREFIX.length).split(".");
			const ivPart = parts[0];
			const ciphertextPart = parts[1];
			if (parts.length !== 2 || !ivPart || !ciphertextPart) throw new Error("Malformed encrypted secret");
			try {
				const plaintext = await crypto.subtle.decrypt(
					{ name: ALGORITHM, iv: fromBase64Url(ivPart), additionalData: encoder.encode(aad) },
					key,
					fromBase64Url(ciphertextPart),
				);
				return decoder.decode(plaintext);
			} catch {
				throw new Error("Stored secret could not be decrypted (wrong master key or corrupted value)");
			}
		},
	};
}

/**
 * Loads the configured master key material: `RELAY_SECRET_KEY` when set,
 * otherwise the contents of `RELAY_SECRET_KEY_FILE`. Returns null when neither
 * is configured.
 */
export async function loadMasterKey(options: {
	key?: string | null;
	file?: string | null;
}): Promise<Uint8Array<ArrayBuffer> | null> {
	if (options.key) return parseMasterKey(options.key);
	if (options.file) return parseMasterKey(await readFile(options.file, "utf8"));
	return null;
}

/**
 * The local master key used when no explicit key is configured: generated on
 * first use under `dir` (mode `0600`, write-then-rename) and reused after.
 * Reading an existing but malformed key fails instead of silently replacing
 * it — overwriting would make every stored secret undecryptable.
 */
export function loadOrCreateLocalMasterKey(dir: string): Uint8Array<ArrayBuffer> {
	const path = join(dir, "secret.key");
	try {
		return parseMasterKey(readFileSync(path, "utf8"));
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	const bytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, `${base64Url(bytes)}\n`, { mode: 0o600 });
		renameSync(tmp, path);
	} catch (error) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// Best effort cleanup.
		}
		throw error;
	}
	return bytes;
}

/** True for `ENOENT` file-system errors. */
export function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}
