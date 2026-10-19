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
		const box = yield* services.boxes.status(sessionId).pipe(Effect.catchCause(() => Effect.succeed(null)));
		const root = box?.workspace ?? handle.getHeader().cwd;
		const files = yield* attempt(() => listProjectFiles(root));
		return json({ cwd: handle.getHeader().cwd, files } satisfies FileListResponse);
	});
}
