import type { WorkspaceResponse } from "@vvtxn/client/protocol.ts";
import type { ServerServices } from "./services.ts";
import { json } from "./http.ts";

/** Returns the server's default workspace directory. */
export function handleWorkspace(services: ServerServices): Response {
	return json({ cwd: services.config.defaultCwd } satisfies WorkspaceResponse);
}
