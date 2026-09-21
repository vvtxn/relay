import { Effect, Either } from "effect";
import type { ConfigResponse, MeResponse } from "@vvtxn/client/protocol.ts";
import { Api, isUnauthorized, RelayError } from "./services.ts";
import { readStoredCwd } from "./storage.ts";
import { serverLabel } from "./client.ts";

export type BootResult =
	| { kind: "ready"; me: MeResponse; config: ConfigResponse; cwd: string; sessionId: string }
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

	const health = yield* Effect.either(api.health());
	if (Either.isLeft(health)) {
		return yield* Effect.fail(
			new RelayError({ message: `Cannot reach the Relay server at ${serverLabel}.` }),
		);
	}

	const me = yield* Effect.either(api.me());
	if (Either.isLeft(me)) {
		if (isUnauthorized(me.left)) return { kind: "unauthenticated" };
		return yield* Effect.fail(me.left);
	}

	const config = yield* api.getConfig();
	const cwd = readStoredCwd() ?? (yield* api.workspace()).cwd;
	const sessions = yield* api.listSessions(cwd);
	const first = sessions.sessions[0];
	const sessionId = first ? first.reference : (yield* api.createSession(cwd)).id;

	return { kind: "ready", me: me.right, config, cwd, sessionId };
});
