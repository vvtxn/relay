// Flavor-based configuration: cloud is the primary deployment, local is the
// self-hosted SQLite mode.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { serverConfigFromEnv } from "../config.ts";

const CLOUD_ENV: Record<string, string> = {
	TURSO_DB_URL: "libsql://example.turso.io",
	TURSO_DB_TOKEN: "test-token",
	GITHUB_APP_CLIENT_ID: "test-client-id",
	GITHUB_APP_CLIENT_SECRET: "test-client-secret",
	RELAY_WORKSPACE: process.cwd(),
	RELAY_WORKSPACE_ROOTS: "*",
	RELAY_DATA_DIR: join(tmpdir(), "relay-config-test"),
};

function without(env: Record<string, string>, ...keys: string[]): Record<string, string> {
	const copy = { ...env };
	for (const key of keys) delete copy[key];
	return copy;
}

const LOCAL_ENV: Record<string, string> = {
	RELAY_FLAVOR: "local",
	RELAY_WORKSPACE: process.cwd(),
	RELAY_DATA_DIR: join(tmpdir(), "relay-config-test"),
	RELAY_DB_PATH: join(tmpdir(), "relay-config-test.db"),
};

describe("serverConfigFromEnv flavor selection", () => {
	it("defaults to cloud with Turso, GitHub, and ten threads", () => {
		const config = serverConfigFromEnv({ ...CLOUD_ENV });

		expect(config.flavor).toBe("cloud");
		expect(config.database.kind).toBe("turso");
		expect(config.authMode).toBe("github");
		expect(config.maxSessionsPerWorkspace).toBe(10);
		expect(config.workspaceRoots).toEqual([]);
	});

	it("runs local mode with SQLite, local auth, and unlimited threads", () => {
		const config = serverConfigFromEnv({ ...LOCAL_ENV });

		expect(config.flavor).toBe("local");
		expect(config.database).toEqual({
			kind: "local",
			path: join(tmpdir(), "relay-config-test.db"),
			url: expect.stringMatching(/^file:\/\//),
		});
		expect(config.authMode).toBe("local");
		expect(config.maxSessionsPerWorkspace).toBe(0);
		expect(config.workspaceRoots).toEqual([]);
	});

	it("ignores cloud credentials in local mode", () => {
		const config = serverConfigFromEnv({
			...LOCAL_ENV,
			TURSO_DB_URL: "libsql://example.turso.io",
			TURSO_DB_TOKEN: "test-token",
			GITHUB_APP_CLIENT_ID: "test-client-id",
			GITHUB_APP_CLIENT_SECRET: "test-client-secret",
		});

		expect(config.database.kind).toBe("local");
		expect(config.authMode).toBe("local");
	});

	it("requires Turso and GitHub credentials in cloud mode", () => {
		expect(() => serverConfigFromEnv(without(CLOUD_ENV, "TURSO_DB_URL"))).toThrow(/TURSO_DB_URL/);
		expect(() => serverConfigFromEnv({ ...CLOUD_ENV, TURSO_DB_TOKEN: "" })).toThrow(/TURSO_DB_TOKEN/);
		expect(() => serverConfigFromEnv(without(CLOUD_ENV, "GITHUB_APP_CLIENT_ID"))).toThrow(/GITHUB_APP_CLIENT_ID/);
	});

	it("rejects an unknown flavor", () => {
		expect(() => serverConfigFromEnv({ ...LOCAL_ENV, RELAY_FLAVOR: "edge" })).toThrow(/RELAY_FLAVOR/);
	});

	it("refuses local auth on a non-loopback host", () => {
		expect(() => serverConfigFromEnv({ ...LOCAL_ENV, RELAY_HOST: "0.0.0.0" })).toThrow(/loopback-only/);
	});

	it("requires allowlists for a non-loopback cloud host", () => {
		const base = { ...CLOUD_ENV, RELAY_HOST: "0.0.0.0", RELAY_WORKSPACE_ROOTS: "/srv/projects" };
		expect(() => serverConfigFromEnv(base)).toThrow(/AUTH_ALLOWED_GITHUB/);

		expect(() =>
			serverConfigFromEnv({
				...base,
				AUTH_ALLOWED_GITHUB: "octocat",
				RELAY_WORKSPACE_ROOTS: "*",
			}),
		).toThrow(/RELAY_WORKSPACE_ROOTS=\*/);
	});
});

describe("serverConfigFromEnv settings backend", () => {
	it("defaults to the local file backend", () => {
		const config = serverConfigFromEnv({ ...CLOUD_ENV });

		expect(config.settingsStore).toBe("file");
		expect(config.secretKey).toBeNull();
		expect(config.secretKeyFile).toBeNull();
		expect(config.dataDir.length).toBeGreaterThan(0);
	});

	it("requires a master key (or key file) for the database backend", () => {
		expect(() => serverConfigFromEnv({ ...CLOUD_ENV, RELAY_SETTINGS_STORE: "database" })).toThrow(
			/RELAY_SECRET_KEY/,
		);

		const withKey = serverConfigFromEnv({
			...CLOUD_ENV,
			RELAY_SETTINGS_STORE: "database",
			RELAY_SECRET_KEY: "key",
		});
		expect(withKey.settingsStore).toBe("database");
		expect(withKey.secretKey).toBe("key");
	});

	it("rejects unknown backends", () => {
		expect(() => serverConfigFromEnv({ ...CLOUD_ENV, RELAY_SETTINGS_STORE: "cloud" })).toThrow(
			/RELAY_SETTINGS_STORE/,
		);
	});

	it("honours RELAY_DATA_DIR", () => {
		const config = serverConfigFromEnv({ ...CLOUD_ENV, RELAY_DATA_DIR: "/var/lib/relay" });
		expect(config.dataDir).toBe("/var/lib/relay");
	});
});

describe("serverConfigFromEnv session limit", () => {
	it("accepts an explicit limit, including zero", () => {
		expect(
			serverConfigFromEnv({ ...CLOUD_ENV, RELAY_MAX_SESSIONS_PER_WORKSPACE: "25" }).maxSessionsPerWorkspace,
		).toBe(25);
		expect(
			serverConfigFromEnv({ ...CLOUD_ENV, RELAY_MAX_SESSIONS_PER_WORKSPACE: "0" }).maxSessionsPerWorkspace,
		).toBe(0);
	});

	it("rejects invalid limits", () => {
		expect(() => serverConfigFromEnv({ ...CLOUD_ENV, RELAY_MAX_SESSIONS_PER_WORKSPACE: "-1" })).toThrow(
			/RELAY_MAX_SESSIONS_PER_WORKSPACE/,
		);
		expect(() => serverConfigFromEnv({ ...CLOUD_ENV, RELAY_MAX_SESSIONS_PER_WORKSPACE: "many" })).toThrow(
			/RELAY_MAX_SESSIONS_PER_WORKSPACE/,
		);
	});
});
