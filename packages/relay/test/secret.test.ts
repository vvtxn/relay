// Encryption for per-user secrets: exact round-trips, owner binding through
// the AAD, tamper detection, and master-key parsing/loading.

import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
	createSecretCipher,
	isEncryptedSecret,
	loadOrCreateLocalMasterKey,
	parseMasterKey,
	userSettingsAad,
} from "../core/auth/secret.ts";

function randomBytes(): Uint8Array<ArrayBuffer> {
	return crypto.getRandomValues(new Uint8Array(32));
}

describe("secret cipher", () => {
	it("round-trips plaintext with a fresh IV per encryption", async () => {
		const cipher = await createSecretCipher(randomBytes());
		const aad = userSettingsAad("user-1");
		const first = await cipher.encrypt("sk-or-v1-abcdef", aad);
		const second = await cipher.encrypt("sk-or-v1-abcdef", aad);

		expect(isEncryptedSecret(first)).toBe(true);
		expect(first).not.toBe(second);
		expect(await cipher.decrypt(first, aad)).toBe("sk-or-v1-abcdef");
		expect(await cipher.decrypt(second, aad)).toBe("sk-or-v1-abcdef");
	});

	it("refuses ciphertext decrypted for a different owner", async () => {
		const cipher = await createSecretCipher(randomBytes());
		const payload = await cipher.encrypt("sk-or-v1-abcdef", userSettingsAad("user-1"));

		await expect(cipher.decrypt(payload, userSettingsAad("user-2"))).rejects.toThrow(/could not be decrypted/);
	});

	it("refuses ciphertext under a different master key", async () => {
		const first = await createSecretCipher(randomBytes());
		const second = await createSecretCipher(randomBytes());
		const payload = await first.encrypt("sk-or-v1-abcdef", userSettingsAad("user-1"));

		await expect(second.decrypt(payload, userSettingsAad("user-1"))).rejects.toThrow(/could not be decrypted/);
	});

	it("refuses tampered and malformed payloads", async () => {
		const cipher = await createSecretCipher(randomBytes());
		const aad = userSettingsAad("user-1");
		const payload = await cipher.encrypt("secret", aad);

		await expect(cipher.decrypt(`${payload.slice(0, -2)}zz`, aad)).rejects.toThrow(/could not be decrypted/);
		await expect(cipher.decrypt("sk-plaintext", aad)).rejects.toThrow(/not an encrypted secret/);
		await expect(cipher.decrypt("v1.only-one-part", aad)).rejects.toThrow(/Malformed/);
	});
});

describe("master keys", () => {
	it("parses base64url and hex forms of the same key", () => {
		const bytes = randomBytes();
		const base64url = Buffer.from(bytes).toString("base64url");
		const hex = Buffer.from(bytes).toString("hex");

		expect(Array.from(parseMasterKey(base64url))).toEqual(Array.from(bytes));
		expect(Array.from(parseMasterKey(` ${hex}\n`))).toEqual(Array.from(bytes));
	});

	it("rejects keys that do not decode to 32 bytes", () => {
		expect(() => parseMasterKey("")).toThrow(/32 bytes/);
		expect(() => parseMasterKey("c2hvcnQ")).toThrow(/32 bytes/);
		expect(() => parseMasterKey("zzzz")).toThrow(/32 bytes/);
	});

	it("generates, persists, and reuses the local master key (mode 0600)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "relay-master-key-"));
		const generated = loadOrCreateLocalMasterKey(dir);
		expect(generated.length).toBe(32);

		const path = join(dir, "secret.key");
		const stats = await stat(path);
		expect(stats.mode & 0o777).toBe(0o600);
		const raw = await readFile(path, "utf8");
		expect(Array.from(parseMasterKey(raw))).toEqual(Array.from(generated));

		expect(Array.from(loadOrCreateLocalMasterKey(dir))).toEqual(Array.from(generated));
	});
});
