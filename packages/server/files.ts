import { listProjectFiles } from "@vvtxn/relay/core/workspace.ts";
import type { FileListResponse } from "@vvtxn/client/protocol.ts";
import type { RequestServices } from "./services.ts";
import { json } from "./http.ts";
import { openSessionHandle } from "./sessions.ts";

/** Returns the project file listing for the session's workspace (for the @-mention picker). */
export async function handleListFiles(services: RequestServices, sessionId: string): Promise<Response> {
	const handle = await openSessionHandle(services, sessionId);

	const cwd = handle.getHeader().cwd;
	const files = await listProjectFiles(cwd);
	return json({ cwd, files } satisfies FileListResponse);
}
