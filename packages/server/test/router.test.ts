// TEMP(effect-migration): characterization tests for the HTTP layer rewrite
// (phase 4, effect/http + @effect/platform-node). Remove after phase 4 — see
// docs/effect-migration.md ("Testing strategy").

import { Effect } from "effect";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { AuthenticatedUser } from "@vvtxn/relay/core/index.ts";
import type { LLMProvider } from "@vvtxn/relay/api/types.ts";
import { handleRequest } from "../router.ts";
import { RunManager } from "../run.ts";
import type { ServerServices } from "../services.ts";
import {
	chunks,
	doneChunk,
	hangUntilAborted,
	makeConfig,
	MemorySessionStore,
	ScriptedProvider,
	textChunk,
	waitFor,
} from "./helpers.ts";

const USER_ID = "user-1";
const TEST_TOKEN = "test-session-token";
const BASE_URL = "http://127.0.0.1:7433";

async function makeServices(provider: LLMProvider) {
	const cwd = await mkdtemp(join(tmpdir(), "relay-router-test-"));
	const config = makeConfig(cwd);
	const store = new MemorySessionStore();
	const runs = new RunManager({ config, providerFor: () => Effect.succeed(provider) });
	const user: AuthenticatedUser = { id: USER_ID, name: "Test User", provider: "github" };

	const services = {
		config,
		db: {},
		userStore: { getById: (id: string) => Effect.succeed(id === USER_ID ? user : null) },
		userSettings: { getApiKey: () => Effect.succeed("fake-key") },
		authSessions: { resolve: (token: string) => Effect.succeed(token === TEST_TOKEN ? { userId: USER_ID } : null) },
		sessionStore: store,
		runs,
	} as unknown as ServerServices;

	return { services, runs, cwd, user };
}

function apiRequest(
	method: string,
	path: string,
	options: { token?: string; origin?: string; body?: unknown } = {},
): Request {
	const headers: Record<string, string> = {};
	if (options.token) headers.authorization = `Bearer ${options.token}`;
	if (options.origin) headers.origin = options.origin;
	let body: string | undefined;
	if (options.body !== undefined) {
		headers["content-type"] = "application/json";
		body = JSON.stringify(options.body);
	}
	return new Request(`${BASE_URL}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
}

describe("handleRequest", () => {
	it("serves /api/health without authentication", async () => {
		const { services } = await makeServices(new ScriptedProvider([]));
		const response = await handleRequest(services, apiRequest("GET", "/api/health"));

		expect(response.status).toBe(200);
		const body = (await response.json()) as { status: string; version: string };
		expect(body.status).toBe("ok");
		expect(typeof body.version).toBe("string");
	});

	it("rejects unauthenticated API requests with 401", async () => {
		const { services } = await makeServices(new ScriptedProvider([]));
		const response = await handleRequest(services, apiRequest("GET", "/api/config"));

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Unauthorized" });
	});

	it("accepts a valid bearer token and resolves the caller", async () => {
		const { services } = await makeServices(new ScriptedProvider([]));
		const configResponse = await handleRequest(services, apiRequest("GET", "/api/config", { token: TEST_TOKEN }));
		expect(configResponse.status).toBe(200);
		const config = (await configResponse.json()) as { model: string };
		expect(config.model).toBe("fake-model");

		const meResponse = await handleRequest(services, apiRequest("GET", "/api/me", { token: TEST_TOKEN }));
		expect(meResponse.status).toBe(200);
		expect(await meResponse.json()).toEqual({ id: USER_ID, name: "Test User", provider: "github" });
	});

	it("rejects cross-origin state-changing API requests with 403", async () => {
		const { services } = await makeServices(new ScriptedProvider([]));
		const response = await handleRequest(
			services,
			apiRequest("POST", "/api/workspaces", { token: TEST_TOKEN, origin: "https://evil.example", body: {} }),
		);
		expect(response.status).toBe(403);
	});

	it("maps unknown paths to 404 and unsupported methods to 405", async () => {
		const { services } = await makeServices(new ScriptedProvider([]));
		const notFound = await handleRequest(services, apiRequest("GET", "/api/nope", { token: TEST_TOKEN }));
		expect(notFound.status).toBe(404);

		const methodNotAllowed = await handleRequest(
			services,
			apiRequest("POST", "/api/sessions/abc", { token: TEST_TOKEN }),
		);
		expect(methodNotAllowed.status).toBe(405);
	});

	it("runs a session end-to-end: create, open, list, send, persist", async () => {
		const provider = new ScriptedProvider([chunks(textChunk("world"), doneChunk())]);
		const { services, runs, cwd } = await makeServices(provider);

		const created = await handleRequest(
			services,
			apiRequest("POST", "/api/sessions", { token: TEST_TOKEN, body: {} }),
		);
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: string };
		expect(typeof id).toBe("string");

		const opened = await handleRequest(services, apiRequest("GET", `/api/sessions/${id}`, { token: TEST_TOKEN }));
		expect(opened.status).toBe(200);
		const snapshot = (await opened.json()) as { header: { id: string }; entries: unknown[]; running: boolean };
		expect(snapshot.header.id).toBe(id);
		expect(snapshot.entries).toEqual([]);
		expect(snapshot.running).toBe(false);

		const listed = await handleRequest(
			services,
			apiRequest("GET", `/api/sessions?cwd=${encodeURIComponent(cwd)}`, { token: TEST_TOKEN }),
		);
		expect(listed.status).toBe(200);

		const sent = await handleRequest(
			services,
			apiRequest("POST", `/api/sessions/${id}/messages`, { token: TEST_TOKEN, body: { content: "hello" } }),
		);
		expect(sent.status).toBe(202);

		await waitFor(() => !runs.isRunning(id));
		const after = await handleRequest(services, apiRequest("GET", `/api/sessions/${id}`, { token: TEST_TOKEN }));
		const afterBody = (await after.json()) as { entries: Array<{ type: string; role?: string }> };
		expect(afterBody.entries.map((entry) => entry.type)).toEqual(["message", "message"]);
		expect(afterBody.entries[1]).toMatchObject({ role: "assistant" });
	});

	it("answers 409 when a message is sent while a run is active", async () => {
		const provider = new ScriptedProvider([hangUntilAborted()]);
		const { services, runs } = await makeServices(provider);

		const created = await handleRequest(
			services,
			apiRequest("POST", "/api/sessions", { token: TEST_TOKEN, body: {} }),
		);
		const { id } = (await created.json()) as { id: string };

		// Open the session so the run manager has a handle, then occupy the slot directly.
		await handleRequest(services, apiRequest("GET", `/api/sessions/${id}`, { token: TEST_TOKEN }));
		runs.startMessage(id, "first");

		const conflict = await handleRequest(
			services,
			apiRequest("POST", `/api/sessions/${id}/messages`, { token: TEST_TOKEN, body: { content: "second" } }),
		);
		expect(conflict.status).toBe(409);

		runs.cancel(id);
		await waitFor(() => !runs.isRunning(id));
	});
});
