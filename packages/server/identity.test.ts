import { assertEquals } from "@std/assert";
import type { AuthenticatedUser } from "@vvtxn/relay/core/index.ts";
import { resolveRequestUser, SESSION_COOKIE } from "./identity.ts";
import type { ServerServices } from "./services.ts";

function fakeServices(options: { session?: boolean; userById?: AuthenticatedUser | null }): ServerServices {
	return {
		config: { sessionTtlDays: 30 },
		userStore: {
			getById: (id: string) =>
				Promise.resolve("userById" in options ? options.userById ?? null : { id, name: "restored" }),
		},
		authSessions: {
			resolve: () =>
				Promise.resolve(options.session ? { userId: "session-user", expiresAt: "2999-01-01T00:00:00Z" } : null),
		},
	} as unknown as ServerServices;
}

Deno.test("resolveRequestUser - returns null without credentials", async () => {
	const services = fakeServices({});
	assertEquals(await resolveRequestUser(services, new Request("http://localhost/api/me")), null);
});

Deno.test("resolveRequestUser - accepts a session cookie", async () => {
	const services = fakeServices({ session: true });
	const request = new Request("http://localhost/api/me", {
		headers: { cookie: `${SESSION_COOKIE}=opaque-token` },
	});
	const user = await resolveRequestUser(services, request);
	assertEquals(user?.id, "session-user");
});

Deno.test("resolveRequestUser - accepts a bearer token", async () => {
	const services = fakeServices({ session: true });
	const request = new Request("http://localhost/api/me", {
		headers: { authorization: "Bearer opaque-token" },
	});
	const user = await resolveRequestUser(services, request);
	assertEquals(user?.id, "session-user");
});

Deno.test("resolveRequestUser - returns null when the session is unknown", async () => {
	const services = fakeServices({ session: false });
	const request = new Request("http://localhost/api/me", {
		headers: { cookie: `${SESSION_COOKIE}=opaque-token` },
	});
	assertEquals(await resolveRequestUser(services, request), null);
});

Deno.test("resolveRequestUser - returns null when the user record is gone", async () => {
	const services = fakeServices({ session: true, userById: null });
	const request = new Request("http://localhost/api/me", {
		headers: { cookie: `${SESSION_COOKIE}=opaque-token` },
	});
	assertEquals(await resolveRequestUser(services, request), null);
});
