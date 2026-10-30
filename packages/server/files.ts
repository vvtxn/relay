import { Effect } from "effect";
import type { HttpServerResponse } from "effect/http";
import { listProjectFiles } from "@vvtxn/relay/core/workspace.ts";
import { attempt } from "@vvtxn/relay/core/effect.ts";
import type { FileListResponse } from "@vvtxn/client/protocol.ts";
import type { RequestServices } from "./services.ts";
import { json, type NotFoundError } from "./http.ts";
import { openSessionHandle } from "./sessions.ts";

/** Returns the project file listing for the session's workspace (for the @-mention picker). */
export function handleListFiles(
	services: RequestServices,
	sessionId: string,
): Effect.Effect<HttpServerResponse.HttpServerResponse, NotFoundError> {
	return Effect.gen(function* () {
		const handle = yield* openSessionHandle(services, sessionId);
		const projectCwd = handle.getHeader().cwd;
		const workspace = services.workspaces.find({
			sessionId,
			ownerId: services.user.id,
			projectCwd,
		});
		const box = yield* services.boxes.findBySession(sessionId).pipe(Effect.catchCause(() => Effect.succeed(null)));
		const root = box?.legacy ? box.workspace : (workspace?.hostPath ?? box?.workspace ?? projectCwd);
		const files = yield* attempt(() => listProjectFiles(root));
		return json({ cwd: projectCwd, files } satisfies FileListResponse);
	});
}
