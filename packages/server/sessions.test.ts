import { assertEquals, assertRejects } from "@std/assert";
import type { SessionHandle, SessionScope, SessionStore } from "@vvtxn/relay/core/sessions/index.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "./http.ts";
import { handleCreateSession, openSessionHandle } from "./sessions.ts";
import type { RequestServices } from "./services.ts";

function fakeHandle(id: string): SessionHandle {
	return {
		append: () => Promise.resolve("entry"),
		getEntries: () => [],
		getHeader: () => ({ type: "session", version: 1, id, timestamp: new Date().toISOString(), cwd: "/tmp" }),
		getTokens: () => 0,
		setTokens: () => {},
		getCost: () => 0,
		setCost: () => {},
		flush: () => Promise.resolve(),
	};
}

function services(options: {
	open: (reference: string, ownerId: string) => Promise<SessionHandle>;
	ownedHandle?: SessionHandle | null;
}): RequestServices {
	return {
		user: { id: "user-1" },
		sessionStore: { open: options.open } as unknown as SessionStore,
		runs: {
			// Emulates the owner-scoped lookup: only the owner sees a handle.
			getHandle: (
				_sessionId: string,
				ownerId?: string,
			) => (ownerId === "user-1" ? options.ownedHandle ?? null : null),
		},
	} as unknown as RequestServices;
}

Deno.test("openSessionHandle - returns the store handle for the owner", async () => {
	const handle = fakeHandle("s1");
	const result = await openSessionHandle(
		services({ open: () => Promise.resolve(handle) }),
		"s1",
	);
	assertEquals(result.getHeader().id, "s1");
});

Deno.test("openSessionHandle - falls back to the owner's in-memory handle", async () => {
	const handle = fakeHandle("s1");
	const result = await openSessionHandle(
		services({ open: () => Promise.reject(new Error("not persisted")), ownedHandle: handle }),
		"s1",
	);
	assertEquals(result.getHeader().id, "s1");
});

Deno.test("openSessionHandle - rejects a session owned by another user", async () => {
	await assertRejects(
		() => openSessionHandle(services({ open: () => Promise.reject(new Error("not persisted")) }), "s1"),
		NotFoundError,
		"Session not found",
	);
});

function createServices(options: { roots: string[]; defaultCwd: string }): {
	services: RequestServices;
	created: SessionScope[];
	registered: SessionScope[];
} {
	const created: SessionScope[] = [];
	const registered: SessionScope[] = [];
	const services = {
		user: { id: "user-1" },
		config: { defaultCwd: options.defaultCwd, workspaceRoots: options.roots },
		sessionStore: {
			create: (scope: SessionScope) => {
				created.push(scope);
				return fakeHandle("new-session");
			},
			registerWorkspace: (scope: SessionScope) => {
				registered.push(scope);
				return Promise.resolve();
			},
		} as unknown as SessionStore,
		runs: { attachHandle: () => {} },
	} as unknown as RequestServices;
	return { services, created, registered };
}

function jsonRequest(body: unknown): Request {
	return new Request("http://localhost/api/sessions", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

Deno.test("handleCreateSession - stores the canonical path and registers the workspace", async () => {
	const dir = await Deno.makeTempDir();
	try {
		const fake = createServices({ roots: [], defaultCwd: dir });
		const response = await handleCreateSession(fake.services, jsonRequest({ cwd: `${dir}/` }));

		assertEquals(response.status, 201);
		assertEquals(fake.created[0]?.cwd, await Deno.realPath(dir));
		assertEquals(fake.registered[0]?.cwd, await Deno.realPath(dir));
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("handleCreateSession - rejects a missing directory", async () => {
	const fake = createServices({ roots: [], defaultCwd: Deno.cwd() });
	await assertRejects(
		() => handleCreateSession(fake.services, jsonRequest({ cwd: "/definitely/not/here" })),
		BadRequestError,
		"No such directory",
	);
});

Deno.test("handleCreateSession - rejects a relative path", async () => {
	const fake = createServices({ roots: [], defaultCwd: Deno.cwd() });
	await assertRejects(
		() => handleCreateSession(fake.services, jsonRequest({ cwd: "relative/project" })),
		BadRequestError,
		"must be absolute",
	);
});

Deno.test("handleCreateSession - rejects a directory outside the roots", async () => {
	const parent = await Deno.makeTempDir();
	try {
		const root = `${parent}/root`;
		const outside = `${parent}/outside`;
		await Deno.mkdir(root);
		await Deno.mkdir(outside);
		const fake = createServices({ roots: [root], defaultCwd: root });
		await assertRejects(
			() => handleCreateSession(fake.services, jsonRequest({ cwd: outside })),
			ForbiddenError,
			"outside the allowed roots",
		);
	} finally {
		await Deno.remove(parent, { recursive: true });
	}
});
