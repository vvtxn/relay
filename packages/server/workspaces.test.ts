import { assertEquals, assertRejects } from "@std/assert";
import type { WorkspaceSummary } from "@vvtxn/relay/core/sessions/index.ts";
import type { WorkspacesResponse } from "@vvtxn/client/protocol.ts";
import { BadRequestError, ForbiddenError } from "./http.ts";
import { handleRegisterWorkspace, handleUnregisterWorkspace, handleValidateWorkspace } from "./workspace.ts";
import { handleListWorkspaces } from "./sessions.ts";
import type { RequestServices } from "./services.ts";

function services(workspaces: WorkspaceSummary[], defaultCwd: string, roots: string[] = []): RequestServices {
	return {
		user: { id: "user-1" },
		config: { defaultCwd, workspaceRoots: roots },
		sessionStore: {
			listWorkspaces: () => Promise.resolve(workspaces),
			registerWorkspace: () => Promise.resolve(),
			unregisterWorkspace: () => Promise.resolve(),
		},
	} as unknown as RequestServices;
}

async function body(response: Response): Promise<WorkspacesResponse> {
	return await response.json() as WorkspacesResponse;
}

Deno.test("handleListWorkspaces - always includes the default workspace", async () => {
	const a = await Deno.makeTempDir();
	const b = await Deno.makeTempDir();
	const response = await handleListWorkspaces(
		services([{ cwd: a, sessionCount: 2, lastActivity: "2026-01-01T00:00:00Z" }], b),
	);

	const workspaces = (await body(response)).workspaces;
	assertEquals(workspaces.map((workspace) => workspace.cwd).sort(), [a, b].sort());
	assertEquals(workspaces.find((workspace) => workspace.cwd === b), {
		cwd: b,
		sessionCount: 0,
		lastActivity: "",
		exists: true,
	});
});

Deno.test("handleListWorkspaces - does not duplicate a known default workspace", async () => {
	const a = await Deno.makeTempDir();
	const known: WorkspaceSummary = { cwd: a, sessionCount: 2, lastActivity: "2026-01-01T00:00:00Z" };
	const response = await handleListWorkspaces(services([known], a));
	assertEquals((await body(response)).workspaces, [{ ...known, exists: true }]);
});

Deno.test("handleListWorkspaces - flags workspaces whose directory is gone", async () => {
	const missing = `${await Deno.makeTempDir()}/deleted`;
	const response = await handleListWorkspaces(
		services([{ cwd: missing, sessionCount: 1, lastActivity: "2026-01-01T00:00:00Z" }], missing),
	);
	const workspaces = (await body(response)).workspaces;
	assertEquals(workspaces.length, 1);
	assertEquals(workspaces[0]!.exists, false);
});

Deno.test("handleValidateWorkspace - returns the canonical path for a valid directory", async () => {
	const dir = await Deno.makeTempDir();
	try {
		const response = await handleValidateWorkspace(services([], dir), new URL(`http://x/?cwd=${dir}`));
		const result = await response.json();
		assertEquals(result.ok, true);
		assertEquals(result.path, await Deno.realPath(dir));
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("handleValidateWorkspace - reports a missing directory without failing", async () => {
	const response = await handleValidateWorkspace(
		services([], Deno.cwd()),
		new URL("http://x/?cwd=%2Fdefinitely%2Fnot%2Fhere"),
	);
	assertEquals(response.status, 200);
	const result = await response.json();
	assertEquals(result.ok, false);
	assertEquals(result.reason, "missing");
	assertEquals(result.roots, []);
});

Deno.test("handleRegisterWorkspace - registers a valid directory", async () => {
	const dir = await Deno.makeTempDir();
	try {
		const request = new Request("http://x/api/workspaces", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: dir }),
		});
		const response = await handleRegisterWorkspace(services([], dir), request);
		assertEquals(response.status, 201);
		const result = await response.json();
		assertEquals(result.workspace.exists, true);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("handleRegisterWorkspace - rejects a directory outside the roots", async () => {
	const parent = await Deno.makeTempDir();
	try {
		const root = `${parent}/root`;
		const outside = `${parent}/outside`;
		await Deno.mkdir(root);
		await Deno.mkdir(outside);
		const request = new Request("http://x/api/workspaces", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: outside }),
		});
		await assertRejects(
			() => handleRegisterWorkspace(services([], root, [root]), request),
			ForbiddenError,
		);
	} finally {
		await Deno.remove(parent, { recursive: true });
	}
});

Deno.test("handleUnregisterWorkspace - requires an absolute cwd", async () => {
	await assertRejects(
		() => handleUnregisterWorkspace(services([], Deno.cwd()), new URL("http://x/api/workspaces?cwd=relative")),
		BadRequestError,
	);
});

Deno.test("handleUnregisterWorkspace - accepts an absolute cwd", async () => {
	const response = await handleUnregisterWorkspace(
		services([], Deno.cwd()),
		new URL("http://x/api/workspaces?cwd=%2Ftmp%2Fproject"),
	);
	assertEquals(response.status, 200);
});
