// Database/auth mode selection: local mode is zero-config, while Turso and
// GitHub remain available for shared deployments.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { serverConfigFromEnv } from "../config.ts";

const BASE_ENV: Record<string, string> = {
	TURSO_DB_URL: "file::memory:",
	TURSO_DB_TOKEN: "test-token",
	GITHUB_APP_CLIENT_ID: "test-client-id",
	GITHUB_APP_CLIENT_SECRET: "test-client-secret",
	RELAY_WORKSPACE: process.cwd(),
	RELAY_WORKSPACE_ROOTS: "*",
	RELAY_DATA_DIR: join(tmpdir(), "relay-config-test"),
};

const LOCAL_ENV: Record<string, string> = {
	RELAY_WORKSPACE: process.cwd(),
	RELAY_WORKSPACE_ROOTS: "*",
	RELAY_DATA_DIR: join(tmpdir(), "relay-config-test"),
	RELAY_DB_PATH: join(tmpdir(), "relay-config-test.db"),
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
});

describe("serverConfigFromEnv database and auth modes", () => {
	it("uses local SQLite and local auth when no cloud config is present", () => {
		const config = serverConfigFromEnv({ ...LOCAL_ENV });

		expect(config.database).toEqual({
			kind: "local",
			path: join(tmpdir(), "relay-config-test.db"),
			url: expect.stringMatching(/^file:\/\//),
		});
		expect(config.authMode).toBe("local");
		expect(config.maxSessionsPerWorkspace).toBe(0);
		expect(config.workspaceRoots).toEqual([]);
	});

	it("keeps Turso + GitHub when credentials are present", () => {
		const config = serverConfigFromEnv({ ...BASE_ENV });

		expect(config.database.kind).toBe("turso");
		expect(config.authMode).toBe("github");
		expect(config.maxSessionsPerWorkspace).toBe(10);
	});

	it("lets RELAY_DB=local override configured Turso credentials", () => {
		const config = serverConfigFromEnv({ ...BASE_ENV, RELAY_DB: "local" });

		expect(config.database.kind).toBe("local");
	});

	it("lets the local flavor ignore cloud credentials", () => {
		const config = serverConfigFromEnv({ ...BASE_ENV, RELAY_FLAVOR: "local" });

		expect(config.database.kind).toBe("local");
		expect(config.authMode).toBe("local");
		expect(config.maxSessionsPerWorkspace).toBe(0);
	});

	it("requires Turso for the cloud flavor", () => {
		expect(() =>
			serverConfigFromEnv({
				RELAY_FLAVOR: "cloud",
				RELAY_WORKSPACE: process.cwd(),
				RELAY_WORKSPACE_ROOTS: "*",
			}),
		).toThrow(/TURSO_DB_URL/);
	});

	it("refuses local auth on a non-loopback host", () => {
		expect(() =>
			serverConfigFromEnv({
				...LOCAL_ENV,
				RELAY_HOST: "0.0.0.0",
				RELAY_AUTH: "local",
			}),
		).toThrow(/loopback-only/);
	});

	it("requires GitHub credentials when GitHub auth is explicit", () => {
		expect(() =>
			serverConfigFromEnv({
				...LOCAL_ENV,
				RELAY_AUTH: "github",
			}),
		).toThrow(/GITHUB_APP_CLIENT_ID/);
	});

	it("rejects malformed database, auth, and flavor values", () => {
		expect(() => serverConfigFromEnv({ ...LOCAL_ENV, RELAY_DB: "postgres" })).toThrow(/RELAY_DB/);
		expect(() => serverConfigFromEnv({ ...LOCAL_ENV, RELAY_AUTH: "token" })).toThrow(/RELAY_AUTH/);
		expect(() => serverConfigFromEnv({ ...LOCAL_ENV, RELAY_FLAVOR: "edge" })).toThrow(/RELAY_FLAVOR/);
	});
});

describe("serverConfigFromEnv session limit", () => {
	it("defaults to unlimited for local databases and 10 for Turso", () => {
		expect(serverConfigFromEnv({ ...LOCAL_ENV }).maxSessionsPerWorkspace).toBe(0);
		expect(serverConfigFromEnv({ ...BASE_ENV }).maxSessionsPerWorkspace).toBe(10);
	});

	it("accepts an explicit limit, including zero", () => {
		expect(
			serverConfigFromEnv({ ...LOCAL_ENV, RELAY_MAX_SESSIONS_PER_WORKSPACE: "25" }).maxSessionsPerWorkspace,
		).toBe(25);
		expect(
			serverConfigFromEnv({ ...BASE_ENV, RELAY_MAX_SESSIONS_PER_WORKSPACE: "0" }).maxSessionsPerWorkspace,
		).toBe(0);
	});

	it("rejects invalid limits", () => {
		expect(() => serverConfigFromEnv({ ...BASE_ENV, RELAY_MAX_SESSIONS_PER_WORKSPACE: "-1" })).toThrow(
			/RELAY_MAX_SESSIONS_PER_WORKSPACE/,
		);
		expect(() => serverConfigFromEnv({ ...BASE_ENV, RELAY_MAX_SESSIONS_PER_WORKSPACE: "many" })).toThrow(
			/RELAY_MAX_SESSIONS_PER_WORKSPACE/,
		);
	});
});
