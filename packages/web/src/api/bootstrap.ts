import { Effect, Result } from "effect";
import type { ConfigResponse, MeResponse } from "@vvtxn/client/protocol.ts";
import type { SessionSummary, WorkspaceSummary } from "@vvtxn/relay/core/sessions/index.ts";
import { Api, isUnauthorized, RelayError } from "./services.ts";
import { readStoredCwd } from "./storage.ts";
import { serverLabel } from "./client.ts";

export type BootResult =
	| {
			kind: "ready";
			me: MeResponse;
			config: ConfigResponse;
			cwd: string;
			sessionId: string;
			/** Seeded into the query cache so the first paint needs no fetches. */
			sessions: SessionSummary[];
			/** Null when the picker query failed — boot must not depend on it. */
			workspaces: WorkspaceSummary[] | null;
	  }
	| { kind: "unauthenticated" };

/**
 * Resolve the app for the current user: verify the server, load identity and
 * config, then open the most recent session for the workspace (or create one).
 *
 * Auth is intentionally a seam: an unauthenticated response is a first-class
 * outcome rather than an error, so the UI can route to the login flow once
 * OAuth replaces local auth. Nothing here assumes the local dev identity.
 */
export const bootstrap: Effect.Effect<BootResult, RelayError, Api> = Effect.gen(function* () {
	const api = yield* Api;

	const health = yield* Effect.result(api.health());
	if (Result.isFailure(health)) {
		return yield* Effect.fail(new RelayError({ message: `Cannot reach the Relay server at ${serverLabel}.` }));
	}

	const me = yield* Effect.result(api.me());
	if (Result.isFailure(me)) {
		if (isUnauthorized(me.failure)) return { kind: "unauthenticated" };
		return yield* Effect.fail(me.failure);
	}

	// Everything the first render needs is fetched in parallel: config, the
	// server's default workspace, workspace-picker data, and validation of the
	// persisted workspace. The picker is optional — its failure must not block
	// boot; the sidebar's own query retries and reports inline.
	const storedCwd = readStoredCwd();
	const [config, workspace, validation, workspaces] = yield* Effect.all(
		[
			api.getConfig(),
			api.workspace(),
			storedCwd ? Effect.result(api.validateWorkspace(storedCwd)) : Effect.succeed(null),
			Effect.result(api.listWorkspaces()),
		],
		{ concurrency: "unbounded" },
	);
	// A persisted workspace may have been deleted server-side since the last
	// visit; fall back to the server default when it is no longer usable.
	let cwd = workspace.cwd;
	if (validation && Result.isSuccess(validation) && validation.success.ok && validation.success.path) {
		cwd = validation.success.path;
	}
	const sessions = yield* api.listSessions(cwd);
	const first = sessions.sessions[0];
	const sessionId = first ? first.reference : (yield* api.createSession(cwd)).id;

	return {
		kind: "ready",
		me: me.success,
		config,
		cwd,
		sessionId,
		sessions: sessions.sessions,
		workspaces: Result.isSuccess(workspaces) ? workspaces.success.workspaces : null,
	};
});
