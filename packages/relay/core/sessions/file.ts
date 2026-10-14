import type { Effect } from "effect";
import { storeEffect, type StoreError } from "../effect.ts";
import { SessionManager } from "./manager.ts";
import type { SessionHandle, SessionScope, SessionStore, SessionSummary } from "./types.ts";

/**
 * Storage contract adapter for the existing JSONL session implementation.
 *
 * This intentionally preserves the current filesystem behavior. It gives
 * database-backed stores the same frontend-facing shape without changing the
 * CLI migration and persistence semantics in the same step.
 */
export class FileSessionStore implements SessionStore {
	create(scope: SessionScope): SessionHandle {
		return SessionManager.create(scope.cwd, scope.ownerId);
	}

	continueRecent(scope: SessionScope): Effect.Effect<SessionHandle | null, StoreError> {
		return storeEffect(() => SessionManager.continueRecent(scope.cwd, scope.ownerId));
	}

	open(reference: string, _ownerId: string): Effect.Effect<SessionHandle, StoreError> {
		return storeEffect(() => SessionManager.open(reference));
	}

	listSummaries(scope: SessionScope): Effect.Effect<SessionSummary[], StoreError> {
		return storeEffect(() => SessionManager.listSummaries(scope.cwd, scope.ownerId));
	}
}
