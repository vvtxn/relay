// Local mode end-to-end: no token, loopback-only, unlimited threads, and no
// GitHub/Turso configuration.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { handleRequest } from "../router.ts";
import { createServices, type ServerServices } from "../services.ts";
import { makeConfig } from "./helpers.ts";

const BASE_URL = "http://127.0.0.1:7433";

async function localServices(): Promise<{ services: ServerServices; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "relay-local-mode-"));
	const databasePath = join(dir, "relay.db");
	const config = makeConfig(dir, {
		database: { kind: "local", path: databasePath, url: pathToFileURL(databasePath).href },
		authMode: "local",
		maxSessionsPerWorkspace: 0,
		dataDir: dir,
	});
	const services = await createServices(config);
	return { services, dir };
}

function apiRequest(method: string, path: string, options: { host?: string; body?: unknown } = {}): Request {
	const headers: Record<string, string> = {};
	if (options.host) headers.host = options.host;
	let body: string | undefined;
	if (options.body !== undefined) {
		headers["content-type"] = "application/json";
		body = JSON.stringify(options.body);
	}
	return new Request(`${BASE_URL}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
}

describe("local mode", () => {
	it("authenticates every loopback request as the local user", async () => {
		const { services, dir } = await localServices();
		try {
			expect(services.localUser).not.toBeNull();

			const health = await handleRequest(services, apiRequest("GET", "/api/health"));
			expect(health.status).toBe(200);
			expect(await health.json()).toMatchObject({ status: "ok", flavor: "local" });

			const me = await handleRequest(services, apiRequest("GET", "/api/me"));
			expect(me.status).toBe(200);
			expect(await me.json()).toMatchObject({ id: services.localUser!.id, provider: "local" });
			expect(me.headers.getSetCookie().some((cookie) => cookie.startsWith("relay_session="))).toBe(true);

			const config = await handleRequest(services, apiRequest("GET", "/api/config"));
			expect(config.status).toBe(200);
			expect(await config.json()).toMatchObject({ maxSessionsPerWorkspace: 0 });
		} finally {
			services.db.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects non-loopback Host headers to block DNS rebinding", async () => {
		const { services, dir } = await localServices();
		try {
			const blocked = await handleRequest(services, apiRequest("GET", "/api/me", { host: "evil.example" }));
			expect(blocked.status).toBe(403);

			const ipv4 = await handleRequest(services, apiRequest("GET", "/api/me", { host: "127.0.0.1:5173" }));
			expect(ipv4.status).toBe(200);
		} finally {
			services.db.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps more than the former ten-thread cap", async () => {
		const { services, dir } = await localServices();
		try {
			const user = services.localUser!;
			for (let index = 0; index < 25; index++) {
				const handle = services.sessionStore.create({ ownerId: user.id, cwd: dir });
				await Effect.runPromise(handle.append({ type: "message", role: "user", content: `thread ${index}` }));
			}

			const listed = await handleRequest(
				services,
				apiRequest("GET", `/api/sessions?cwd=${encodeURIComponent(dir)}`),
			);
			expect(listed.status).toBe(200);
			const body = (await listed.json()) as { sessions: unknown[] };
			expect(body.sessions).toHaveLength(25);
		} finally {
			services.db.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("does not mount OAuth routes in local mode", async () => {
		const { services, dir } = await localServices();
		try {
			const login = await handleRequest(services, apiRequest("GET", "/api/auth/login"));
			expect(login.status).toBe(404);
		} finally {
			services.db.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("stores API keys in the local settings files", async () => {
		const { services, dir } = await localServices();
		try {
			const set = await handleRequest(
				services,
				apiRequest("PUT", "/api/settings/api-key", { body: { apiKey: "sk-local-abcd" } }),
			);
			expect(set.status).toBe(200);

			const status = await handleRequest(services, apiRequest("GET", "/api/settings"));
			expect(await status.json()).toEqual({ apiKey: { set: true, hint: "abcd" } });
		} finally {
			services.db.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
});
