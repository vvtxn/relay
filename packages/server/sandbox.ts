import { Effect } from "effect";
import type { BoxLease, BoxManager, BoxSettings, BoxStatus, BoxSyncResult } from "@vvtxn/box/types.ts";
import type { BoxError } from "@vvtxn/box/errors.ts";
import { hasWorkspaceBaseline } from "@vvtxn/box/sync.ts";
import { causeMessage } from "@vvtxn/relay/core/effect.ts";
import type { RunPhase } from "@vvtxn/client/protocol.ts";

/** The durable workspace a run edits. Boxes are leased lazily and pinned per run. */
export interface RunWorkspace {
	hostPath: string;
	execPath: string;
	projectCwd: string;
	sync: () => Effect.Effect<BoxSyncResult, BoxError>;
}

export interface SandboxPhaseInfo {
	boxId?: string;
	queuePosition?: number;
}

/**
 * Lazily leases a box for one run. The first sandbox tool pins a lease for the
 * rest of the run so services, shells, and browser checks stay on one VM.
 */
export interface SandboxProvider {
	readonly workspace: RunWorkspace;
	readonly syncAvailable: boolean;
	withLease<T>(fn: (lease: BoxLease) => Effect.Effect<T, BoxError>): Effect.Effect<T, BoxError>;
	/** Inspect the pinned box without provisioning one. */
	status(): Effect.Effect<BoxStatus | null, BoxError>;
	sync(): Effect.Effect<BoxSyncResult, BoxError>;
	/** Release the pinned lease at the end of a run. */
	release(): Effect.Effect<void>;
}

export function createSandboxProvider(options: {
	boxes: BoxManager;
	settings: BoxSettings;
	runId: string;
	sessionId: string;
	ownerId: string;
	projectCwd: string;
	workspace: RunWorkspace;
	signal: AbortSignal;
	onPhase?: (phase: RunPhase, info?: SandboxPhaseInfo) => void;
}): SandboxProvider {
	const { boxes, settings, runId, sessionId, ownerId, projectCwd, workspace, signal, onPhase } = options;
	let lease: BoxLease | null = null;
	return {
		workspace,
		get syncAvailable(): boolean {
			return hasWorkspaceBaseline(workspace.hostPath);
		},
		withLease<T>(fn: (lease: BoxLease) => Effect.Effect<T, BoxError>): Effect.Effect<T, BoxError> {
			return Effect.gen(function* () {
				let current = lease;
				if (!current) {
					onPhase?.("starting-box");
					current = yield* boxes.acquire({
						ownerId,
						projectCwd,
						sessionId,
						runId,
						workspace: workspace.hostPath,
						execPath: workspace.execPath,
						settings,
						signal,
						onQueued: (position) => onPhase?.("queued", { queuePosition: position }),
					});
					lease = current;
					onPhase?.("running", { boxId: current.boxId });
				}
				return yield* fn(current);
			});
		},
		status(): Effect.Effect<BoxStatus | null, BoxError> {
			const current = lease;
			return current ? boxes.status(current.boxId) : Effect.succeed(null);
		},
		sync(): Effect.Effect<BoxSyncResult, BoxError> {
			return Effect.gen(function* () {
				onPhase?.("syncing");
				return yield* workspace.sync();
			});
		},
		release(): Effect.Effect<void> {
			return Effect.gen(function* () {
				const current = lease;
				lease = null;
				if (current) yield* current.release();
			}).pipe(
				Effect.catchCause((cause) =>
					Effect.sync(() => {
						console.warn(`relay box: could not release the run lease: ${causeMessage(cause)}`);
					}),
				),
			);
		},
	};
}
