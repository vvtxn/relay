import { Effect, Result } from "effect";
import type { ConfigResponse, MeResponse } from "@vvtxn/client/protocol.ts";
import type { WorkspaceSummary } from "@vvtxn/relay/core/sessions/index.ts";
import { Api, isUnauthorized, RelayError } from "@vvtxn/client/services.ts";
import { serverLabel } from "./client.ts";

export type BootResult =
	| {
			kind: "ready";
			me: MeResponse;
			config: ConfigResponse;
			/** Server default workspace; the last-resort "New chat" target. */
			defaultCwd: string;
			/** Workspace picker data, seeded so the sidebar's first render needs no fetch. */
			workspaces: WorkspaceSummary[] | null;
	  }
	| { kind: "unauthenticated" };

/**
 * Resolve the app for the current user: verify the server, load identity and
 * config, and seed the workspace picker. Landing no longer opens (or creates) a
 * session — the overview lists workspaces, and chats start explicitly from one.
 *
 * Auth is intentionally a seam: an unauthenticated response is a first-class
 * outcome rather than an error, so the UI can route to the login flow once
 * OAuth replaces local auth.
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

	// The picker is optional — its failure must not block first paint; the
	// sidebar's own query retries and reports inline.
	const [config, workspace, workspaces] = yield* Effect.all(
		[api.getConfig(), api.workspace(), Effect.result(api.listWorkspaces())],
		{ concurrency: "unbounded" },
	);

	return {
		kind: "ready",
		me: me.success,
		config,
		defaultCwd: workspace.cwd,
		workspaces: Result.isSuccess(workspaces) ? workspaces.success.workspaces : null,
	};
});
