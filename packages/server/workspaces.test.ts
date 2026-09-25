import { assertEquals } from "@std/assert";
import type { WorkspaceSummary } from "@vvtxn/relay/core/sessions/index.ts";
import type { WorkspacesResponse } from "@vvtxn/client/protocol.ts";
import { handleListWorkspaces } from "./sessions.ts";
import type { RequestServices } from "./services.ts";

function services(workspaces: WorkspaceSummary[], defaultCwd: string): RequestServices {
	return {
		user: { id: "user-1" },
		config: { defaultCwd },
		sessionStore: { listWorkspaces: () => Promise.resolve(workspaces) },
	} as unknown as RequestServices;
}

async function body(response: Response): Promise<WorkspacesResponse> {
	return await response.json() as WorkspacesResponse;
}

Deno.test("handleListWorkspaces - always includes the default workspace", async () => {
	const response = await handleListWorkspaces(
		services([{ cwd: "/a", sessionCount: 2, lastActivity: "2026-01-01T00:00:00Z" }], "/b"),
	);

	const workspaces = (await body(response)).workspaces;
	assertEquals(workspaces.map((workspace) => workspace.cwd).sort(), ["/a", "/b"]);
	assertEquals(workspaces.find((workspace) => workspace.cwd === "/b"), {
		cwd: "/b",
		sessionCount: 0,
		lastActivity: "",
	});
});

Deno.test("handleListWorkspaces - does not duplicate a known default workspace", async () => {
	const known: WorkspaceSummary = { cwd: "/a", sessionCount: 2, lastActivity: "2026-01-01T00:00:00Z" };
	const response = await handleListWorkspaces(services([known], "/a"));
	assertEquals((await body(response)).workspaces, [known]);
});
