import type { WorkspaceResponse } from "@vvtxn/client/protocol.ts";
import type { RequestServices } from "./services.ts";
import { json } from "./http.ts";

/** Returns the server's default workspace directory. */
export function handleWorkspace(services: RequestServices): Response {
	return json({ cwd: services.config.defaultCwd } satisfies WorkspaceResponse);
}
