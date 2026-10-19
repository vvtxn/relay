// Settings-backend configuration: file by default, database only with a
// master key, and no silent fallback for unknown values.

import { describe, expect, it } from "vite-plus/test";
import { serverConfigFromEnv } from "../config.ts";

const BASE_ENV: Record<string, string> = {
	TURSO_DB_URL: "file::memory:",
	TURSO_DB_TOKEN: "test-token",
	GITHUB_APP_CLIENT_ID: "test-client-id",
	GITHUB_APP_CLIENT_SECRET: "test-client-secret",
	RELAY_WORKSPACE: process.cwd(),
	RELAY_WORKSPACE_ROOTS: "*",
};

describe("serverConfigFromEnv settings backend", () => {
	it("defaults to the local file backend", () => {
		const config = serverConfigFromEnv({ ...BASE_ENV });

		expect(config.settingsStore).toBe("file");
		expect(config.secretKey).toBeNull();
		expect(config.secretKeyFile).toBeNull();
		expect(config.dataDir.length).toBeGreaterThan(0);
	});

	it("requires a master key (or key file) for the database backend", () => {
		expect(() => serverConfigFromEnv({ ...BASE_ENV, RELAY_SETTINGS_STORE: "database" })).toThrow(
			/RELAY_SECRET_KEY/,
		);

		const withKey = serverConfigFromEnv({ ...BASE_ENV, RELAY_SETTINGS_STORE: "database", RELAY_SECRET_KEY: "key" });
		expect(withKey.settingsStore).toBe("database");
		expect(withKey.secretKey).toBe("key");

		const withFile = serverConfigFromEnv({
			...BASE_ENV,
			RELAY_SETTINGS_STORE: "database",
			RELAY_SECRET_KEY_FILE: "/run/secrets/relay",
		});
		expect(withFile.secretKeyFile).toBe("/run/secrets/relay");
	});

	it("rejects unknown backends", () => {
		expect(() => serverConfigFromEnv({ ...BASE_ENV, RELAY_SETTINGS_STORE: "cloud" })).toThrow(
			/RELAY_SETTINGS_STORE/,
		);
	});

	it("honours RELAY_DATA_DIR", () => {
		const config = serverConfigFromEnv({ ...BASE_ENV, RELAY_DATA_DIR: "/var/lib/relay" });
		expect(config.dataDir).toBe("/var/lib/relay");
	});

	it("defaults the per-workspace session limit to 10 and accepts an override", () => {
		expect(serverConfigFromEnv({ ...BASE_ENV }).maxSessionsPerWorkspace).toBe(10);
		expect(
			serverConfigFromEnv({ ...BASE_ENV, RELAY_MAX_SESSIONS_PER_WORKSPACE: "25" }).maxSessionsPerWorkspace,
		).toBe(25);
	});

	it("rejects invalid per-workspace session limits", () => {
		expect(() => serverConfigFromEnv({ ...BASE_ENV, RELAY_MAX_SESSIONS_PER_WORKSPACE: "0" })).toThrow(
			/RELAY_MAX_SESSIONS_PER_WORKSPACE/,
		);
		expect(() => serverConfigFromEnv({ ...BASE_ENV, RELAY_MAX_SESSIONS_PER_WORKSPACE: "many" })).toThrow(
			/RELAY_MAX_SESSIONS_PER_WORKSPACE/,
		);
	});

	it("defaults boxes off with a bounded runtime configuration", () => {
		const config = serverConfigFromEnv({ ...BASE_ENV });
		expect(config.box.enabled).toBe(false);
		expect(config.box.defaults.image).toBe("node:26-bookworm");
		expect(config.box.maxRunning).toBe(4);
		expect(config.box.dataDir.endsWith("/boxes")).toBe(true);
	});

	it("parses box overrides and rejects malformed values", () => {
		const config = serverConfigFromEnv({
			...BASE_ENV,
			RELAY_BOX: "1",
			RELAY_BOX_IMAGE: "relay-box:local",
			RELAY_BOX_MAX_RUNNING: "2",
			RELAY_BOX_MEMORY_MIB: "4096",
		});
		expect(config.box.enabled).toBe(true);
		expect(config.box.defaults.image).toBe("relay-box:local");
		expect(config.box.maxRunning).toBe(2);
		expect(config.box.defaults.memoryMiB).toBe(4096);
		expect(() => serverConfigFromEnv({ ...BASE_ENV, RELAY_BOX: "sometimes" })).toThrow(/RELAY_BOX/);
		expect(() => serverConfigFromEnv({ ...BASE_ENV, RELAY_BOX_MAX_RUNNING: "0" })).toThrow(/RELAY_BOX_MAX_RUNNING/);
	});
});
