import { assertEquals, assertRejects } from "@std/assert";
import type { SessionHandle, SessionStore } from "@vvtxn/relay/core/sessions/index.ts";
import { NotFoundError } from "./http.ts";
import { openSessionHandle } from "./sessions.ts";
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
