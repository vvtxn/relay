// HTTP contract tests: auth gate, CSRF, 404/405 mapping, the session flow,
// SSE streaming, and SPA/API precedence.

import { Effect } from "effect";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { AuthenticatedUser } from "@vvtxn/relay/core/index.ts";
import type { LLMProvider } from "@vvtxn/relay/api/types.ts";
import type { ServerConfig } from "../config.ts";
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

async function makeServices(provider: LLMProvider, overrides: Partial<ServerConfig> = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "relay-router-test-"));
	const config = makeConfig(cwd, overrides);
	const store = new MemorySessionStore();
	const runs = new RunManager({ config, providerFor: () => Effect.succeed(provider) });
	const user: AuthenticatedUser = { id: USER_ID, name: "Test User", provider: "github" };

	const services = {
		config,
		db: {},
		userStore: { getById: (id: string) => Effect.succeed(id === USER_ID ? user : null) },
		userSettings: {
			getApiKey: () => Effect.succeed("fake-key"),
			getApiKeyStatus: () => Effect.succeed({ set: true, hint: "1234" }),
		},
		authSessions: { resolve: (token: string) => Effect.succeed(token === TEST_TOKEN ? { userId: USER_ID } : null) },
		sessionStore: store,
		runs,
	} as unknown as ServerServices;

	return { services, runs, cwd, user };
}

function apiRequest(
	method: string,
	path: string,
	options: { token?: string; origin?: string; body?: unknown; accept?: string } = {},
): Request {
	const headers: Record<string, string> = {};
	if (options.token) headers.authorization = `Bearer ${options.token}`;
	if (options.origin) headers.origin = options.origin;
	if (options.accept) headers.accept = options.accept;
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

	it("serves per-user settings as presence plus a masked hint", async () => {
		const { services } = await makeServices(new ScriptedProvider([]));
		const response = await handleRequest(services, apiRequest("GET", "/api/settings", { token: TEST_TOKEN }));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ apiKey: { set: true, hint: "1234" } });
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

	it("reuses the idle empty session until something is sent", async () => {
		const provider = new ScriptedProvider([chunks(textChunk("hi"), doneChunk())]);
		const { services, runs } = await makeServices(provider);

		const first = await handleRequest(
			services,
			apiRequest("POST", "/api/sessions", { token: TEST_TOKEN, body: {} }),
		);
		const second = await handleRequest(
			services,
			apiRequest("POST", "/api/sessions", { token: TEST_TOKEN, body: {} }),
		);
		expect(first.status).toBe(201);
		const firstBody = (await first.json()) as { id: string };
		const secondBody = (await second.json()) as { id: string };
		expect(secondBody.id).toBe(firstBody.id);

		// Once a message is sent the session is no longer empty: the next create
		// starts a new thread.
		const sent = await handleRequest(
			services,
			apiRequest("POST", `/api/sessions/${firstBody.id}/messages`, {
				token: TEST_TOKEN,
				body: { content: "hello" },
			}),
		);
		expect(sent.status).toBe(202);
		await waitFor(() => !runs.isRunning(firstBody.id));

		const third = await handleRequest(
			services,
			apiRequest("POST", "/api/sessions", { token: TEST_TOKEN, body: {} }),
		);
		const thirdBody = (await third.json()) as { id: string };
		expect(thirdBody.id).not.toBe(firstBody.id);
	});

	it("resolves a symlinked workspace to the stored canonical path when listing", async () => {
		const { services } = await makeServices(new ScriptedProvider([]));
		const real = await mkdtemp(join(tmpdir(), "relay-real-"));
		const link = `${real}-link`;
		await symlink(real, link);

		const created = await handleRequest(
			services,
			apiRequest("POST", "/api/sessions", { token: TEST_TOKEN, body: { cwd: link } }),
		);
		expect(created.status).toBe(201);

		const listed = await handleRequest(
			services,
			apiRequest("GET", `/api/sessions?cwd=${encodeURIComponent(link)}`, { token: TEST_TOKEN }),
		);
		expect(listed.status).toBe(200);
		const body = (await listed.json()) as { sessions: unknown[] };
		expect(body.sessions).toHaveLength(1);
	});

	it("surfaces the default workspace only until another one is known", async () => {
		const { services, cwd } = await makeServices(new ScriptedProvider([]));
		const other = await mkdtemp(join(tmpdir(), "relay-other-"));

		const initial = await handleRequest(services, apiRequest("GET", "/api/workspaces", { token: TEST_TOKEN }));
		const initialBody = (await initial.json()) as { workspaces: Array<{ cwd: string }> };
		expect(initialBody.workspaces.map((workspace) => workspace.cwd)).toEqual([cwd]);

		const registered = await handleRequest(
			services,
			apiRequest("POST", "/api/workspaces", { token: TEST_TOKEN, body: { cwd: other } }),
		);
		expect(registered.status).toBe(201);

		const after = await handleRequest(services, apiRequest("GET", "/api/workspaces", { token: TEST_TOKEN }));
		const afterBody = (await after.json()) as { workspaces: Array<{ cwd: string }> };
		expect(afterBody.workspaces.map((workspace) => workspace.cwd)).toEqual([other]);
	});

	it("keeps a removed workspace hidden until a session is created there", async () => {
		const { services, cwd } = await makeServices(new ScriptedProvider([]));

		const registered = await handleRequest(
			services,
			apiRequest("POST", "/api/workspaces", { token: TEST_TOKEN, body: { cwd } }),
		);
		expect(registered.status).toBe(201);
		const removed = await handleRequest(
			services,
			apiRequest("DELETE", `/api/workspaces?cwd=${encodeURIComponent(cwd)}`, { token: TEST_TOKEN }),
		);
		expect(removed.status).toBe(200);

		// Hidden — and not re-injected through the server-default fallback either.
		const hidden = await handleRequest(services, apiRequest("GET", "/api/workspaces", { token: TEST_TOKEN }));
		const hiddenBody = (await hidden.json()) as { workspaces: Array<{ cwd: string }> };
		expect(hiddenBody.workspaces).toEqual([]);

		// Creating a session in the directory registers (and unhides) it again.
		const created = await handleRequest(
			services,
			apiRequest("POST", "/api/sessions", { token: TEST_TOKEN, body: { cwd } }),
		);
		expect(created.status).toBe(201);
		const after = await handleRequest(services, apiRequest("GET", "/api/workspaces", { token: TEST_TOKEN }));
		const afterBody = (await after.json()) as { workspaces: Array<{ cwd: string }> };
		expect(afterBody.workspaces.map((workspace) => workspace.cwd)).toEqual([cwd]);
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

	it("streams SSE frames with a catch-up run_state snapshot", async () => {
		const provider = new ScriptedProvider([hangUntilAborted()]);
		const { services, runs } = await makeServices(provider);

		const created = await handleRequest(
			services,
			apiRequest("POST", "/api/sessions", { token: TEST_TOKEN, body: {} }),
		);
		const { id } = (await created.json()) as { id: string };
		await handleRequest(services, apiRequest("GET", `/api/sessions/${id}`, { token: TEST_TOKEN }));
		runs.startMessage(id, "hold the run open");
		await waitFor(() => runs.isRunning(id));

		const response = await handleRequest(
			services,
			apiRequest("GET", `/api/sessions/${id}/events`, { token: TEST_TOKEN }),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");

		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		const decoder = new TextDecoder();
		let text = "";
		const deadline = Date.now() + 3000;
		while (!text.includes('"type":"run_state"') && Date.now() < deadline) {
			const { value, done } = await reader!.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		await reader!.cancel();

		expect(text).toContain(": connected");
		expect(text).toContain('"type":"run_state"');

		runs.cancel(id);
		await waitFor(() => !runs.isRunning(id));
	});

	it("serves the SPA for non-API GETs and keeps API 404s as JSON", async () => {
		const staticDir = await mkdtemp(join(tmpdir(), "relay-static-test-"));
		await writeFile(join(staticDir, "index.html"), "<html>spa shell</html>");
		const { services } = await makeServices(new ScriptedProvider([]), { staticDir });

		const spa = await handleRequest(services, apiRequest("GET", "/some/client/route", { accept: "text/html" }));
		expect(spa.status).toBe(200);
		expect(await spa.text()).toContain("spa shell");

		const apiMissing = await handleRequest(services, apiRequest("GET", "/api/nope", { token: TEST_TOKEN }));
		expect(apiMissing.status).toBe(404);
		expect(await apiMissing.json()).toEqual({ error: "Not found" });

		const wrongMethod = await handleRequest(services, apiRequest("POST", "/some/client/route"));
		expect(wrongMethod.status).toBe(404);
	});
});
