// The local file backend: encrypted round-trips, status reads that work
// without the master key, clearing, permissions, and failure on corruption.

import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { createSecretCipher } from "../core/auth/secret.ts";
import { FileUserSettingsStore } from "../core/auth/settings-file.ts";

async function makeStore(dir: string): Promise<FileUserSettingsStore> {
	const cipher = await createSecretCipher(crypto.getRandomValues(new Uint8Array(32)));
	return new FileUserSettingsStore({ dir, cipher });
}

describe("FileUserSettingsStore", () => {
	it("round-trips a key and writes it encrypted with mode 0600", async () => {
		const dir = await mkdtemp(join(tmpdir(), "relay-settings-"));
		const store = await makeStore(dir);

		await Effect.runPromise(store.setApiKey("user-1", "sk-or-v1-abcdef"));
		expect(await Effect.runPromise(store.getApiKey("user-1"))).toBe("sk-or-v1-abcdef");
		expect(await Effect.runPromise(store.getApiKeyStatus("user-1"))).toEqual({ set: true, hint: "cdef" });

		const path = join(dir, "user-1.json");
		const raw = await readFile(path, "utf8");
		expect(raw).not.toContain("sk-or-v1-abcdef");
		expect(raw).toContain("v1.");
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	it("reports missing keys and clears on null", async () => {
		const dir = await mkdtemp(join(tmpdir(), "relay-settings-"));
		const store = await makeStore(dir);

		expect(await Effect.runPromise(store.getApiKey("user-1"))).toBeNull();
		expect(await Effect.runPromise(store.getApiKeyStatus("user-1"))).toEqual({ set: false, hint: null });

		await Effect.runPromise(store.setApiKey("user-1", "sk-or-v1-abcdef"));
		await Effect.runPromise(store.setApiKey("user-1", null));
		expect(await Effect.runPromise(store.getApiKey("user-1"))).toBeNull();
		expect(await Effect.runPromise(store.getApiKeyStatus("user-1"))).toEqual({ set: false, hint: null });
	});

	it("serves status without the master key while decryption fails", async () => {
		const dir = await mkdtemp(join(tmpdir(), "relay-settings-"));
		const writer = await makeStore(dir);
		await Effect.runPromise(writer.setApiKey("user-1", "sk-or-v1-abcdef"));

		const reader = await makeStore(dir);
		expect(await Effect.runPromise(reader.getApiKeyStatus("user-1"))).toEqual({ set: true, hint: "cdef" });
		await expect(Effect.runPromise(reader.getApiKey("user-1"))).rejects.toThrow(/could not be decrypted/);
	});

	it("fails loudly on a corrupt document", async () => {
		const dir = await mkdtemp(join(tmpdir(), "relay-settings-"));
		const store = await makeStore(dir);
		await writeFile(join(dir, "user-1.json"), "{not json", { mode: 0o600 });

		await expect(Effect.runPromise(store.getApiKey("user-1"))).rejects.toThrow(/not valid JSON/);
	});

	it("rejects user ids that are not server-generated", async () => {
		const dir = await mkdtemp(join(tmpdir(), "relay-settings-"));
		const store = await makeStore(dir);

		await expect(Effect.runPromise(store.setApiKey("../escape", "sk"))).rejects.toThrow(/Invalid user id/);
		await expect(Effect.runPromise(store.getApiKey(".hidden"))).rejects.toThrow(/Invalid user id/);
	});
});
