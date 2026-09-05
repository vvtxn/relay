import { listProjectFiles } from "@vvtxn/relay/core/workspace.ts";
import type { FileListResponse } from "@vvtxn/client/protocol.ts";
import type { ServerServices } from "./services.ts";
import { json, NotFoundError } from "./http.ts";

/** Returns the project file listing for the session's workspace (for the @-mention picker). */
export async function handleListFiles(services: ServerServices, sessionId: string): Promise<Response> {
	let handle;
	try {
		handle = await services.sessionStore.open(sessionId, services.user.id);
	} catch {
		throw new NotFoundError(`Session not found: ${sessionId}`);
	}

	const cwd = handle.getHeader().cwd;
	const files = await listProjectFiles(cwd);
	return json({ cwd, files } satisfies FileListResponse);
}
