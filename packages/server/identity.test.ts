import { assertEquals } from "@std/assert";
import type { AuthenticatedUser } from "@vvtxn/relay/core/index.ts";
import { LOCAL_SUBJECT_HEADER, resolveRequestUser, SESSION_COOKIE } from "./identity.ts";
import type { ServerServices } from "./services.ts";

/** Minimal serve info carrying a client hostname. */
function serveInfo(hostname: string): Deno.ServeHandlerInfo {
	return {
		remoteAddr: { transport: "tcp", hostname, port: 12345 },
		localAddr: { transport: "tcp", hostname: "127.0.0.1", port: 7433 },
	} as unknown as Deno.ServeHandlerInfo;
}

function fakeServices(options: {
	authProvider: "local" | "github";
	allowLocalAuth?: boolean;
	session?: boolean;
	userById?: AuthenticatedUser | null;
}): ServerServices {
	return {
		config: {
			authProvider: options.authProvider,
			allowLocalAuth: options.allowLocalAuth ?? false,
			devAuthSubject: options.authProvider === "local" ? "dev" : null,
			sessionTtlDays: 30,
		},
		userStore: {
			resolve: (identity: { subject: string }) =>
				Promise.resolve({ id: `user:${identity.subject}`, name: identity.subject }),
			getById: (id: string) => Promise.resolve(options.userById ?? { id, name: "restored" }),
		},
		authSessions: {
			resolve: () =>
				Promise.resolve(options.session ? { userId: "session-user", expiresAt: "2999-01-01T00:00:00Z" } : null),
		},
	} as unknown as ServerServices;
}

Deno.test("resolveRequestUser - local mode returns the configured dev subject", async () => {
	const services = fakeServices({ authProvider: "local" });
	const user = await resolveRequestUser(services, new Request("http://localhost/api/me"));
	assertEquals(user?.id, "user:dev");
});

Deno.test("resolveRequestUser - github mode without credentials returns null", async () => {
	const services = fakeServices({ authProvider: "github" });
	assertEquals(await resolveRequestUser(services, new Request("http://localhost/api/me")), null);
});

Deno.test("resolveRequestUser - github mode accepts a session cookie", async () => {
	const services = fakeServices({ authProvider: "github", session: true });
	const request = new Request("http://localhost/api/me", {
		headers: { cookie: `${SESSION_COOKIE}=opaque-token` },
	});
	const user = await resolveRequestUser(services, request);
	assertEquals(user?.id, "session-user");
});

Deno.test("resolveRequestUser - github mode accepts a bearer token", async () => {
	const services = fakeServices({ authProvider: "github", session: true });
	const request = new Request("http://localhost/api/me", {
		headers: { authorization: "Bearer opaque-token" },
	});
	const user = await resolveRequestUser(services, request);
	assertEquals(user?.id, "session-user");
});

Deno.test("resolveRequestUser - github mode honors the local bridge header from loopback", async () => {
	const services = fakeServices({ authProvider: "github", allowLocalAuth: true });
	const request = new Request("http://localhost/api/me", {
		headers: { [LOCAL_SUBJECT_HEADER]: "cli-user" },
	});
	const user = await resolveRequestUser(services, request, serveInfo("127.0.0.1"));
	assertEquals(user?.id, "user:cli-user");
});

Deno.test("resolveRequestUser - github mode ignores the local bridge header from a remote address", async () => {
	const services = fakeServices({ authProvider: "github", allowLocalAuth: true });
	const request = new Request("http://localhost/api/me", {
		headers: { [LOCAL_SUBJECT_HEADER]: "cli-user" },
	});
	assertEquals(await resolveRequestUser(services, request, serveInfo("203.0.113.5")), null);
	assertEquals(await resolveRequestUser(services, request), null);
});

Deno.test("resolveRequestUser - github mode ignores the local bridge header when disabled", async () => {
	const services = fakeServices({ authProvider: "github", allowLocalAuth: false });
	const request = new Request("http://localhost/api/me", {
		headers: { [LOCAL_SUBJECT_HEADER]: "cli-user" },
	});
	assertEquals(await resolveRequestUser(services, request, serveInfo("127.0.0.1")), null);
});
