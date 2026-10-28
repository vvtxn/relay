import { existsSync, mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Effect } from "effect";
import { boxExecEnv } from "./env.ts";
import { BoxError, toBoxError } from "./errors.ts";
import { FileBoxStore, MANIFEST_VERSION, type BoxManifest, type SetupState } from "./manifest.ts";
import { MicrosandboxRuntime } from "./microsandbox.ts";
import {
	acquireDataDirLock,
	boxDir,
	createBoxId,
	dataDirHash,
	ensureBoxDirs,
	sandboxNameFor,
	workspacePath,
} from "./paths.ts";
import { isPreparedBoxImage, PREPARED_BOX_IMAGE } from "./images.ts";
import { profileRank, profileResources } from "./profiles.ts";
import { createWorkspaceBaseline, hasWorkspaceBaseline, syncWorkspace } from "./sync.ts";
import { cleanupTempWorkspaces, prepareWorkspace } from "./workspace.ts";
import type {
	BoxAttachment,
	BoxLease,
	BoxManager,
	BoxManagerConfig,
	BoxProfile,
	BoxRuntime,
	BoxSettings,
	BoxSpec,
	BoxState,
	BoxStatus,
	BoxSyncResult,
	ExecOptions,
	ExecResult,
	GcResult,
	RuntimeResizeResult,
	RuntimeStatus,
} from "./types.ts";

const SWEEP_INTERVAL_MS = 30_000;
const GC_INTERVAL_MS = 5 * 60_000;
const EVICTION_RETRY_MS = 30_000;
const TRASH_TTL_MS = 7 * 24 * 60 * 60_000;
const MICROSANDBOX_VERSION = "0.7.8";

interface BoxResources {
	cpus: number;
	memoryMiB: number;
}

interface Resident {
	boxId: string;
	resources: BoxResources;
	leases: number;
	state: "starting" | "ready" | "busy" | "paused";
	lastUsedAt: number;
	pausedAt: number | null;
	stopping: boolean;
}

interface PendingAcquire {
	boxId: string;
	spec: BoxSpec;
	resources: BoxResources;
	isNew: boolean;
	signal?: AbortSignal;
	resolve: () => void;
	reject: (error: BoxError) => void;
	timer: NodeJS.Timeout | null;
	settled: boolean;
	cleanup: () => void;
}

function combineSignals(first: AbortSignal | undefined, second: AbortSignal | undefined): AbortSignal | undefined {
	if (!first) return second;
	if (!second) return first;
	return AbortSignal.any([first, second]);
}

class Mutex {
	private tail: Promise<void> = Promise.resolve();

	async run<T>(fn: () => Promise<T> | T): Promise<T> {
		let release!: () => void;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		const previous = this.tail;
		this.tail = previous.then(() => next);
		await previous;
		try {
			return await fn();
		} finally {
			release();
		}
	}
}

class Lease implements BoxLease {
	private released = false;
	private readonly manager: BoxManagerImpl;
	readonly boxId: string;
	readonly status: BoxStatus;
	readonly workspace: string;
	readonly syncAvailable: boolean;

	constructor(manager: BoxManagerImpl, status: BoxStatus, workspace: string) {
		this.manager = manager;
		this.boxId = status.boxId;
		this.status = status;
		this.workspace = workspace;
		this.syncAvailable = hasWorkspaceBaseline(workspace);
	}

	sync(): Effect.Effect<BoxSyncResult, BoxError> {
		return this.manager.sync(this.boxId);
	}

	exec(command: string, options?: ExecOptions): Effect.Effect<ExecResult, BoxError> {
		return this.manager.exec(this.boxId, command, options);
	}

	release(): Effect.Effect<void> {
		return Effect.promise(async () => {
			if (this.released) return;
			this.released = true;
			await this.manager.release(this.boxId);
		});
	}
}

/** Boxes are disabled: runs keep using the host workspace. */
export class DisabledBoxManager implements BoxManager {
	readonly enabled = false;

	create(): Effect.Effect<BoxStatus, BoxError> {
		return Effect.fail(new BoxError({ message: "Boxes are disabled (set RELAY_BOX=1 to enable)" }));
	}

	acquire(): Effect.Effect<BoxLease, BoxError> {
		return Effect.fail(new BoxError({ message: "Boxes are disabled (set RELAY_BOX=1 to enable)" }));
	}

	findBySession(): Effect.Effect<BoxStatus | null, BoxError> {
		return Effect.succeed(null);
	}

	status(): Effect.Effect<BoxStatus | null, BoxError> {
		return Effect.succeed(null);
	}

	list(_ownerId?: string): Effect.Effect<BoxStatus[], BoxError> {
		return Effect.succeed([]);
	}

	attach(): Effect.Effect<BoxStatus, BoxError> {
		return Effect.fail(new BoxError({ message: "Boxes are disabled (set RELAY_BOX=1 to enable)" }));
	}

	detach(): Effect.Effect<void, BoxError> {
		return Effect.void;
	}

	detachSessions(): Effect.Effect<number, BoxError> {
		return Effect.succeed(0);
	}

	resize(): Effect.Effect<BoxStatus, BoxError> {
		return Effect.fail(new BoxError({ message: "Boxes are disabled (set RELAY_BOX=1 to enable)" }));
	}

	pause(): Effect.Effect<void, BoxError> {
		return Effect.void;
	}

	resume(): Effect.Effect<void, BoxError> {
		return Effect.void;
	}

	stop(): Effect.Effect<void, BoxError> {
		return Effect.void;
	}

	destroy(): Effect.Effect<void, BoxError> {
		return Effect.void;
	}

	sync(): Effect.Effect<BoxSyncResult, BoxError> {
		return Effect.fail(new BoxError({ message: "Boxes are disabled (set RELAY_BOX=1 to enable)" }));
	}

	gc(): Effect.Effect<GcResult, BoxError> {
		return Effect.succeed({ removed: 0, trashed: 0, detached: 0 });
	}

	reconcile(): Effect.Effect<void, BoxError> {
		return Effect.void;
	}

	shutdown(): Effect.Effect<void, BoxError> {
		return Effect.void;
	}
}

export class BoxManagerImpl implements BoxManager {
	readonly enabled = true;
	private readonly config: BoxManagerConfig;
	private readonly store: FileBoxStore;
	private readonly runtime: BoxRuntime;
	private readonly releaseLock: () => void;
	/** Resident VMs (starting, ready, busy, or paused); these consume budget. */
	private readonly resident = new Map<string, Resident>();
	private readonly boxesLock = new Map<string, Mutex>();
	private readonly sessionsLock = new Map<string, Mutex>();
	private readonly manifestLocks = new Map<string, Mutex>();
	/** Last failed eviction per box; used to avoid retrying the same victim in a tight loop. */
	private readonly evictionFailures = new Map<string, number>();
	private readonly schedulerLock = new Mutex();
	private readonly queue: PendingAcquire[] = [];
	private readonly sessionIndex = new Map<string, Set<string>>();
	private sweepTimer: NodeJS.Timeout | null = null;
	private sweeping = false;
	private shuttingDown = false;
	private pumpScheduled = false;
	private imageFallbackWarned = false;
	private lastGcAt = 0;

	constructor(config: BoxManagerConfig, runtime?: BoxRuntime) {
		this.config = config;
		mkdirSync(config.cacheDir, { recursive: true, mode: 0o700 });
		this.store = new FileBoxStore(config.dataDir);
		this.releaseLock = acquireDataDirLock(config.dataDir);
		this.runtime = runtime ?? new MicrosandboxRuntime(config.cacheDir);
		this.rebuildSessionIndex();
		this.sweepTimer = setInterval(() => {
			void this.sweep();
		}, SWEEP_INTERVAL_MS);
		this.sweepTimer.unref();
	}

	create(spec: BoxSpec): Effect.Effect<BoxStatus, BoxError> {
		return Effect.tryPromise({
			try: async () => {
				const boxId = this.nextBoxId();
				const normalized: BoxSpec = { ...spec, settings: this.normalizeSettings(spec.settings) };
				const manifest = await this.withBoxLock(boxId, () => this.createManifest(normalized, boxId));
				const status = await this.statusInternal(boxId, manifest);
				if (!status) throw new BoxError({ message: `Box ${boxId} disappeared after creation` });
				return status;
			},
			catch: (error) => toBoxError(error, "Could not create box"),
		});
	}

	acquire(spec: BoxSpec): Effect.Effect<BoxLease, BoxError> {
		return Effect.tryPromise({
			try: (signal) => this.acquireInternal(spec, signal),
			catch: (error) => toBoxError(error, "Could not acquire box"),
		});
	}

	findBySession(sessionId: string): Effect.Effect<BoxStatus | null, BoxError> {
		return Effect.tryPromise({
			try: async () => {
				const manifest = this.manifestForSession(sessionId);
				return manifest ? await this.statusInternal(manifest.boxId, manifest) : null;
			},
			catch: (error) => toBoxError(error, "Could not find box"),
		});
	}

	status(boxId: string): Effect.Effect<BoxStatus | null, BoxError> {
		return Effect.tryPromise({
			try: () => this.statusInternal(boxId),
			catch: (error) => toBoxError(error, "Could not inspect box"),
		});
	}

	list(ownerId?: string): Effect.Effect<BoxStatus[], BoxError> {
		return Effect.tryPromise({
			try: async () => {
				const statuses: BoxStatus[] = [];
				for (const manifest of this.store.list()) {
					if (ownerId !== undefined && manifest.ownerId !== ownerId) continue;
					const status = await this.statusInternal(manifest.boxId, manifest);
					if (status) statuses.push(status);
				}
				return statuses.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
			},
			catch: (error) => toBoxError(error, "Could not list boxes"),
		});
	}

	attach(boxId: string, sessionId: string): Effect.Effect<BoxStatus, BoxError> {
		return Effect.tryPromise({
			try: async () => {
				await this.withBoxLock(boxId, async () => {
					this.requireManifest(boxId);
					await this.attachInternal(boxId, sessionId);
				});
				const status = await this.statusInternal(boxId);
				if (!status) throw new BoxError({ message: `Box ${boxId} disappeared` });
				return status;
			},
			catch: (error) => toBoxError(error, "Could not attach box"),
		});
	}

	detach(boxId: string, sessionId: string): Effect.Effect<void, BoxError> {
		return Effect.tryPromise({
			try: async () => {
				await this.withBoxLock(boxId, async () => {
					const resident = this.resident.get(boxId);
					if (resident && resident.leases > 0) {
						throw new BoxError({ message: "Cannot detach a box while a run is using it" });
					}
					this.requireManifest(boxId);
					await this.updateManifest(boxId, (manifest) => {
						if (!manifest.attachments.some((attachment) => attachment.sessionId === sessionId)) {
							return null;
						}
						return {
							...manifest,
							attachments: manifest.attachments.filter(
								(attachment) => attachment.sessionId !== sessionId,
							),
						};
					});
				});
			},
			catch: (error) => toBoxError(error, "Could not detach box"),
		});
	}

	detachSessions(sessionIds: ReadonlySet<string>): Effect.Effect<number, BoxError> {
		return Effect.tryPromise({
			try: () => this.detachSessionsInternal(sessionIds),
			catch: (error) => toBoxError(error, "Could not detach sessions"),
		});
	}

	resize(boxId: string, profile: BoxProfile): Effect.Effect<BoxStatus, BoxError> {
		return Effect.tryPromise({
			try: () => this.withBoxLock(boxId, () => this.resizeInternal(boxId, profile)),
			catch: (error) => toBoxError(error, "Could not resize box"),
		});
	}

	pause(boxId: string): Effect.Effect<void, BoxError> {
		return Effect.tryPromise({
			try: () => this.pauseInternal(boxId),
			catch: (error) => toBoxError(error, "Could not pause box"),
		});
	}

	resume(boxId: string): Effect.Effect<void, BoxError> {
		return Effect.tryPromise({
			try: () => this.resumeInternal(boxId),
			catch: (error) => toBoxError(error, "Could not resume box"),
		});
	}

	stop(boxId: string): Effect.Effect<void, BoxError> {
		return Effect.tryPromise({
			try: () => this.stopInternal(boxId),
			catch: (error) => toBoxError(error, "Could not stop box"),
		});
	}

	destroy(boxId: string): Effect.Effect<void, BoxError> {
		return Effect.tryPromise({
			try: () => this.destroyInternal(boxId),
			catch: (error) => toBoxError(error, "Could not remove box"),
		});
	}

	sync(boxId: string): Effect.Effect<BoxSyncResult, BoxError> {
		return Effect.tryPromise({
			try: async () => {
				const manifest = this.requireManifest(boxId);
				const result = await syncWorkspace(manifest.workspacePath, manifest.projectCwd);
				await this.updateManifest(boxId, (current) => ({
					...current,
					lastUsedAt: new Date().toISOString(),
				}));
				return result;
			},
			catch: (error) => toBoxError(error, "Could not sync box changes"),
		});
	}

	gc(activeSessionIds: ReadonlySet<string>): Effect.Effect<GcResult, BoxError> {
		return Effect.tryPromise({
			try: () => this.gcInternal(activeSessionIds),
			catch: (error) => toBoxError(error, "Could not collect boxes"),
		});
	}

	reconcile(): Effect.Effect<void, BoxError> {
		return Effect.tryPromise({
			try: () => this.reconcileInternal(),
			catch: (error) => toBoxError(error, "Could not reconcile boxes"),
		});
	}

	shutdown(): Effect.Effect<void, BoxError> {
		return Effect.tryPromise({
			try: () => this.shutdownInternal(),
			catch: (error) => toBoxError(error, "Could not stop boxes"),
		});
	}

	exec(boxId: string, command: string, options: ExecOptions = {}): Effect.Effect<ExecResult, BoxError> {
		return Effect.tryPromise({
			try: async (interruptSignal) => {
				const manifest = this.store.load(boxId);
				if (!manifest) throw new BoxError({ message: `No box found: ${boxId}` });
				const resident = this.resident.get(boxId);
				if (!resident || resident.state === "paused") {
					throw new BoxError({ message: `Box ${boxId} is not running` });
				}
				const signal = combineSignals(options.signal, interruptSignal);
				return await this.runtime.exec(manifest.sandboxName, command, {
					cwd: options.cwd ?? "/workspace",
					env: boxExecEnv(manifest.settings, options.env),
					timeoutMs: options.timeoutMs ?? 30_000,
					...(signal ? { signal } : {}),
				});
			},
			catch: (error) => toBoxError(error, "Command failed"),
		});
	}

	async release(boxId: string): Promise<void> {
		let lastLease = false;
		await this.schedulerLock.run(() => {
			const resident = this.resident.get(boxId);
			if (!resident) return;
			resident.leases = Math.max(0, resident.leases - 1);
			if (resident.leases === 0) {
				resident.state = "ready";
				resident.lastUsedAt = Date.now();
				lastLease = true;
			}
		});
		if (lastLease) {
			await this.updateManifest(boxId, (manifest) => ({
				...manifest,
				state: "ready",
				lastUsedAt: new Date().toISOString(),
			}));
		}
		this.schedulePump();
	}

	private async acquireInternal(spec: BoxSpec, interruptSignal: AbortSignal): Promise<BoxLease> {
		const signal = combineSignals(spec.signal, interruptSignal);
		const key = spec.sessionId ?? `standalone:${createBoxId()}`;
		return await this.withSessionLock(key, async () => {
			if (signal?.aborted) throw new BoxError({ message: "Box acquisition was cancelled" });
			let manifest = spec.sessionId ? this.manifestForSession(spec.sessionId) : null;
			if (manifest && manifest.ownerId !== spec.ownerId) {
				throw new BoxError({ message: "This box belongs to a different user" });
			}
			const isNew = manifest === null;
			const boxId = manifest?.boxId ?? this.nextBoxId();
			// A resident box is already consuming its configured resources, so
			// reserve what is actually running. A stopped/new box uses the
			// settings clamped to the current server ceiling.
			const normalized = this.normalizeSettings(manifest?.settings ?? spec.settings);
			const settings = manifest && this.resident.has(boxId) ? manifest.settings : normalized;
			const resources = { cpus: settings.cpus, memoryMiB: settings.memoryMiB };

			await this.waitForGrant({
				boxId,
				spec: { ...spec, settings },
				resources,
				isNew,
				...(signal ? { signal } : {}),
			});
			if (signal?.aborted) {
				await this.releaseReservation(boxId, this.isStartingReservation(boxId));
				throw new BoxError({ message: "Box acquisition was cancelled" });
			}

			try {
				manifest = isNew
					? await this.withBoxLock(boxId, () => this.createManifest({ ...spec, settings }, boxId))
					: { ...this.requireManifest(boxId), settings };
				const started = await this.withBoxLock(boxId, () => this.startBox(manifest as BoxManifest, signal));
				if (signal?.aborted) throw new BoxError({ message: "Box acquisition was cancelled" });
				const status = await this.statusInternal(boxId, started);
				if (!status) throw new BoxError({ message: `Box ${boxId} disappeared during startup` });
				// Backfill a baseline for boxes created before sync support. This
				// cannot recover changes made before this run, but it lets this and
				// later runs sync cleanly instead of failing forever.
				if (!hasWorkspaceBaseline(status.workspace)) {
					try {
						if (await createWorkspaceBaseline(status.workspace)) {
							console.warn(
								`relay box: initialized a sync baseline for legacy box ${boxId}; ` +
									"earlier changes remain in the box workspace",
							);
						}
					} catch (error) {
						console.warn(
							`relay box: could not initialize sync for ${boxId}:`,
							error instanceof Error ? error.message : error,
						);
					}
				}
				if (signal?.aborted) throw new BoxError({ message: "Box acquisition was cancelled" });
				return new Lease(this, status, status.workspace);
			} catch (error) {
				const cancelled = signal?.aborted === true;
				const failed = this.store.load(boxId);
				if (failed) {
					await this.runtime.stop(failed.sandboxName).catch(() => {});
					await this.updateManifest(boxId, (current) =>
						cancelled
							? this.stoppedManifest(current)
							: { ...current, state: "error", error: toBoxError(error).message },
					);
				}
				await this.releaseReservation(boxId, true);
				if (cancelled) throw new BoxError({ message: "Box acquisition was cancelled" });
				throw toBoxError(error, "Could not start box");
			}
		});
	}

	/** True when the granted resident was created by this acquisition, not reused. */
	private isStartingReservation(boxId: string): boolean {
		const resident = this.resident.get(boxId);
		return !resident || resident.state === "starting";
	}

	private async waitForGrant(
		item: Omit<PendingAcquire, "resolve" | "reject" | "timer" | "settled" | "cleanup">,
	): Promise<void> {
		return await new Promise<void>((resolvePromise, rejectPromise) => {
			const pending: PendingAcquire = {
				...item,
				resolve: resolvePromise,
				reject: rejectPromise,
				timer: null,
				settled: false,
				cleanup: () => {},
			};
			const cleanup = (): void => {
				if (pending.timer) clearTimeout(pending.timer);
				pending.timer = null;
				pending.signal?.removeEventListener("abort", onAbort);
			};
			const fail = (error: BoxError): void => {
				if (pending.settled) return;
				pending.settled = true;
				cleanup();
				const index = this.queue.indexOf(pending);
				if (index >= 0) this.queue.splice(index, 1);
				rejectPromise(error);
				// A cancelled/timed-out head waiter must not leave later
				// requests blocked behind it.
				this.schedulePump();
			};
			const onAbort = (): void => fail(new BoxError({ message: "Box acquisition was cancelled" }));
			pending.cleanup = cleanup;
			pending.timer = setTimeout(
				() => fail(new BoxError({ message: "Timed out waiting for box capacity" })),
				this.config.acquireTimeoutMs,
			);
			pending.timer.unref();
			pending.signal?.addEventListener("abort", onAbort, { once: true });
			// The signal may have aborted between the caller's check and the
			// listener registration.
			if (pending.signal?.aborted) {
				fail(new BoxError({ message: "Box acquisition was cancelled" }));
				return;
			}
			this.queue.push(pending);
			void this.pump();
		});
	}

	private schedulePump(): void {
		if (this.pumpScheduled) return;
		this.pumpScheduled = true;
		setImmediate(() => {
			this.pumpScheduled = false;
			void this.pump();
		});
	}

	private async pump(): Promise<void> {
		const grants: PendingAcquire[] = [];
		const evictions: string[] = [];
		await this.schedulerLock.run(() => {
			if (this.shuttingDown) return;
			for (let index = 0; index < this.queue.length;) {
				const pending = this.queue[index];
				if (!pending) break;
				if (pending.settled) {
					this.queue.splice(index, 1);
					continue;
				}
				const resident = this.resident.get(pending.boxId);
				if (resident) {
					if (resident.stopping || resident.leases > 0) {
						// This box is busy/stopping, but unrelated boxes later in
						// the queue can still start. Keep the blocked request at
						// the head so it keeps its FIFO priority.
						index += 1;
						continue;
					}
					resident.leases = 1;
					resident.state = "busy";
					resident.lastUsedAt = Date.now();
					this.queue.splice(index, 1);
					pending.settled = true;
					grants.push(pending);
					continue;
				}
				if (!this.canFit(pending.resources)) {
					const victim = this.pickVictim();
					if (victim) {
						victim.stopping = true;
						evictions.push(victim.boxId);
					}
					// Preserve FIFO: a large request blocks later requests until the
					// capacity situation changes.
					break;
				}
				this.resident.set(pending.boxId, {
					boxId: pending.boxId,
					resources: pending.resources,
					leases: 1,
					state: "starting",
					lastUsedAt: Date.now(),
					pausedAt: null,
					stopping: false,
				});
				this.queue.splice(index, 1);
				pending.settled = true;
				grants.push(pending);
			}
		});
		for (const pending of grants) {
			pending.cleanup();
			pending.resolve();
		}
		for (const boxId of evictions) void this.evict(boxId);
	}

	private canFit(resources: BoxResources): boolean {
		if (this.resident.size >= this.config.maxRunning) return false;
		let cpus = 0;
		let memory = 0;
		for (const resident of this.resident.values()) {
			cpus += resident.resources.cpus;
			memory += resident.resources.memoryMiB + this.config.vmOverheadMiB;
		}
		return (
			cpus + resources.cpus <= this.config.maxCpus &&
			memory + resources.memoryMiB + this.config.vmOverheadMiB <= this.config.maxMemoryMiB
		);
	}

	private pickVictim(excludeBoxId?: string, excluded?: ReadonlySet<string>): Resident | null {
		const now = Date.now();
		let victim: Resident | null = null;
		for (const resident of this.resident.values()) {
			if (resident.boxId === excludeBoxId) continue;
			if (excluded?.has(resident.boxId)) continue;
			if (resident.leases > 0 || resident.stopping) continue;
			const failedAt = this.evictionFailures.get(resident.boxId);
			if (failedAt !== undefined && now - failedAt < EVICTION_RETRY_MS) continue;
			if (!victim) {
				victim = resident;
				continue;
			}
			const residentPaused = resident.state === "paused";
			const victimPaused = victim.state === "paused";
			if (residentPaused !== victimPaused) {
				if (residentPaused) victim = resident;
				continue;
			}
			if (resident.lastUsedAt < victim.lastUsedAt) victim = resident;
		}
		return victim;
	}

	private async evict(boxId: string): Promise<boolean> {
		const manifest = this.store.load(boxId);
		let evicted = false;
		try {
			if (manifest) await this.runtime.stop(manifest.sandboxName);
			if (manifest) {
				await this.updateManifest(boxId, (current) => this.stoppedManifest(current));
			}
			await this.schedulerLock.run(() => {
				this.resident.delete(boxId);
			});
			this.evictionFailures.delete(boxId);
			evicted = true;
			return true;
		} catch (error) {
			this.evictionFailures.set(boxId, Date.now());
			console.warn(`relay box: could not evict ${boxId}: ${toBoxError(error).message}`);
			await this.schedulerLock.run(() => {
				const resident = this.resident.get(boxId);
				if (resident) resident.stopping = false;
			});
			return false;
		} finally {
			if (evicted) {
				this.schedulePump();
			} else {
				const timer = setTimeout(() => this.schedulePump(), EVICTION_RETRY_MS);
				timer.unref();
			}
		}
	}

	private async releaseReservation(boxId: string, remove: boolean): Promise<void> {
		await this.schedulerLock.run(() => {
			const resident = this.resident.get(boxId);
			if (!resident) return;
			resident.leases = Math.max(0, resident.leases - 1);
			if (remove || (resident.leases === 0 && resident.state === "starting")) {
				this.resident.delete(boxId);
				return;
			}
			if (resident.leases === 0) {
				resident.state = "ready";
				resident.lastUsedAt = Date.now();
			}
		});
		this.schedulePump();
	}

	private async createManifest(spec: BoxSpec, boxId: string): Promise<BoxManifest> {
		const normalized = this.normalizeSettings(spec.settings);
		const dir = boxDir(this.config.dataDir, boxId);
		const workspace = workspacePath(this.config.dataDir, boxId);
		if (isPathInside(spec.projectCwd, this.config.dataDir)) {
			throw new BoxError({ message: "The project directory must not be inside the box data directory" });
		}
		if (isPathInside(this.config.dataDir, spec.projectCwd)) {
			throw new BoxError({ message: "The box data directory must not be inside the project directory" });
		}
		const settings = normalized.image === "auto" ? { ...normalized, image: await this.resolveImage() } : normalized;
		let wrote = false;
		try {
			ensureBoxDirs(this.config.dataDir, boxId);
			cleanupTempWorkspaces(dir);
			if (!existsSync(workspace)) {
				const removed = await prepareWorkspace(spec.projectCwd, dir, workspace, settings.exclude);
				if (removed.length > 0) {
					console.log(`relay box: removed ${removed.length} host-specific file(s) from ${boxId}`);
				}
			}
			const now = new Date().toISOString();
			const attachments: BoxAttachment[] = spec.sessionId ? [{ sessionId: spec.sessionId, attachedAt: now }] : [];
			const manifest: BoxManifest = {
				version: MANIFEST_VERSION,
				boxId,
				...(spec.sessionId ? { originSessionId: spec.sessionId } : {}),
				attachments,
				ownerId: spec.ownerId,
				projectCwd: spec.projectCwd,
				workspacePath: workspace,
				sandboxName: sandboxNameFor(this.config.dataDir, boxId),
				runtime: { kind: this.runtime.kind, version: MICROSANDBOX_VERSION },
				settings,
				state: "provisioning",
				setupState: "pending",
				createdAt: now,
				lastUsedAt: now,
			};
			this.store.write(manifest);
			wrote = true;
			this.indexManifest(manifest);
			console.log(`relay box: created ${boxId} at ${workspace}`);
			return manifest;
		} catch (error) {
			if (!wrote) {
				try {
					rmSync(dir, { recursive: true, force: true });
				} catch {
					// The failed box is behind a random id; leave it for a later cleanup.
				}
			}
			throw error;
		}
	}

	private async startBox(initial: BoxManifest, signal?: AbortSignal): Promise<BoxManifest> {
		const checkAborted = (): void => {
			if (signal?.aborted) throw new BoxError({ message: "Box start was cancelled" });
		};
		checkAborted();
		let manifest = initial;
		if (manifest.settings.image === "auto") {
			manifest = { ...manifest, settings: { ...manifest.settings, image: await this.resolveImage() } };
			checkAborted();
		}
		// Persist the effective settings (and preserve any attachments added while
		// the box was being acquired) before the runtime sees them.
		const persisted = await this.updateManifest(manifest.boxId, (current) => ({
			...current,
			settings: manifest.settings,
		}));
		if (!persisted) throw new BoxError({ message: `Box ${manifest.boxId} disappeared during startup` });
		manifest = persisted;
		checkAborted();

		if (!existsSync(manifest.workspacePath)) {
			await this.markBoxError(manifest.boxId, "Box workspace is missing");
			throw new BoxError({ message: `Box workspace is missing: ${manifest.workspacePath}` });
		}

		const before = await this.runtime.status(manifest.sandboxName);
		checkAborted();
		let coldStart = false;
		if (before === "paused") {
			await this.runtime.resume(manifest.sandboxName);
			checkAborted();
		} else {
			const needsStart = before !== "running" && before !== "starting" && before !== "draining";
			if (before === "absent") {
				try {
					await this.runtime.create({
						name: manifest.sandboxName,
						settings: manifest.settings,
						workspace: manifest.workspacePath,
						labels: this.labels(manifest.boxId),
						secrets: this.config.secrets,
						maxCpus: this.config.maxCpus,
						maxMemoryMiB: this.config.maxMemoryMiB,
					});
					coldStart = true;
					checkAborted();
				} catch (error) {
					const current = await this.runtime.status(manifest.sandboxName).catch(() => "absent" as const);
					if (current !== "absent") {
						await this.runtime.start(manifest.sandboxName);
						coldStart = true;
						checkAborted();
					} else {
						await this.markBoxError(manifest.boxId, toBoxError(error).message);
						throw error;
					}
				}
			} else if (needsStart) {
				try {
					await this.runtime.start(manifest.sandboxName);
					coldStart = true;
					checkAborted();
				} catch (error) {
					if (before === "crashed") {
						await this.runtime.destroy(manifest.sandboxName).catch(() => {});
						await this.runtime.create({
							name: manifest.sandboxName,
							settings: manifest.settings,
							workspace: manifest.workspacePath,
							labels: this.labels(manifest.boxId),
							secrets: this.config.secrets,
							maxCpus: this.config.maxCpus,
							maxMemoryMiB: this.config.maxMemoryMiB,
						});
						coldStart = true;
						checkAborted();
					} else {
						await this.markBoxError(manifest.boxId, toBoxError(error).message);
						throw error;
					}
				}
			}
		}

		if (manifest.setupState !== "ok" && manifest.settings.setup) {
			const setupState = await this.runHook(manifest, "setup", manifest.settings.setup, true, signal);
			checkAborted();
			const updated = await this.updateManifest(manifest.boxId, (current) => ({ ...current, setupState }));
			if (!updated) throw new BoxError({ message: `Box ${manifest.boxId} disappeared during setup` });
			manifest = updated;
			if (setupState === "failed") {
				await this.markBoxError(manifest.boxId, "Box setup failed; see logs/setup.log");
				throw new BoxError({ message: "Box setup failed; see logs/setup.log" });
			}
		}
		if (manifest.setupState === "pending" && !manifest.settings.setup) {
			manifest = { ...manifest, setupState: "ok" };
		}
		if (manifest.setupState === "failed") {
			await this.markBoxError(manifest.boxId, "Box setup failed; see logs/setup.log");
			throw new BoxError({ message: "Box setup failed; see logs/setup.log" });
		}

		if (coldStart && manifest.settings.resume) {
			await this.runHook(manifest, "resume", manifest.settings.resume, false, signal);
			checkAborted();
		}

		checkAborted();
		const busy = await this.updateManifest(manifest.boxId, (current) => {
			const next = this.withState({ ...current, setupState: manifest.setupState }, "busy");
			delete next.pausedAt;
			return next;
		});
		if (!busy) throw new BoxError({ message: `Box ${manifest.boxId} disappeared during startup` });
		await this.schedulerLock.run(() => {
			const resident = this.resident.get(manifest.boxId);
			if (resident) {
				resident.state = "busy";
				resident.pausedAt = null;
				resident.stopping = false;
				resident.lastUsedAt = Date.now();
			}
		});
		return busy;
	}

	private async runHook(
		manifest: BoxManifest,
		name: "setup" | "resume",
		command: string,
		fatal: boolean,
		signal?: AbortSignal,
	): Promise<SetupState> {
		const result = await this.runtime.exec(manifest.sandboxName, command, {
			cwd: "/workspace",
			env: boxExecEnv(manifest.settings),
			timeoutMs: this.config.setupTimeoutMs,
			...(signal ? { signal } : {}),
		});
		const output = [
			`$ ${command}`,
			`exit ${result.code}${result.truncated ? " (truncated)" : ""}`,
			result.stdout,
			result.stderr,
		]
			.filter(Boolean)
			.join("\n");
		try {
			await writeFile(join(this.store.logs(manifest.boxId), `${name}.log`), `${output}\n`, "utf8");
		} catch {
			// Logs are diagnostic; a full disk should not hide the hook result.
		}
		if (result.code !== 0) {
			if (fatal) return "failed";
			console.warn(`relay box: ${name} hook exited with ${result.code}`);
		}
		return "ok";
	}

	private async statusInternal(boxId: string, known?: BoxManifest): Promise<BoxStatus | null> {
		const manifest = known ?? this.store.load(boxId);
		if (!manifest) return null;
		const resident = this.resident.get(boxId);
		// The manager is the only lifecycle writer. A resident box reports from
		// the scheduler, and a terminal stopped box does not need a runtime probe.
		let runtimeStatus: RuntimeStatus = "absent";
		if (!resident && manifest.state !== "stopped" && manifest.state !== "provisioning") {
			try {
				runtimeStatus = await this.runtime.status(manifest.sandboxName);
			} catch {
				runtimeStatus = manifest.state === "error" ? "crashed" : "absent";
			}
		}
		let state: BoxState;
		if (manifest.setupState === "failed") {
			state = "error";
		} else if (resident) {
			if (resident.state === "paused") state = "paused";
			else if (resident.leases > 0) state = "busy";
			else if (resident.state === "starting") state = "starting";
			else state = "ready";
		} else {
			state = this.mapRuntimeState(manifest, runtimeStatus);
		}
		const status = this.statusFromManifest(manifest, state);
		return { ...status, capacity: this.capacity() };
	}

	private capacity(): NonNullable<BoxStatus["capacity"]> {
		let usedCpus = 0;
		let usedMemoryMiB = 0;
		for (const resident of this.resident.values()) {
			usedCpus += resident.resources.cpus;
			usedMemoryMiB += resident.resources.memoryMiB + this.config.vmOverheadMiB;
		}
		return {
			maxRunning: this.config.maxRunning,
			running: this.resident.size,
			maxCpus: this.config.maxCpus,
			usedCpus,
			maxMemoryMiB: this.config.maxMemoryMiB,
			usedMemoryMiB,
		};
	}

	private mapRuntimeState(manifest: BoxManifest, status: RuntimeStatus): BoxState {
		if (manifest.setupState === "failed") return "error";
		switch (status) {
			case "running":
			case "starting":
			case "draining":
				return "ready";
			case "paused":
				return "paused";
			case "crashed":
				return "error";
			case "created":
			case "stopped":
			case "absent":
				return manifest.state === "error" ? "error" : "stopped";
		}
	}

	private statusFromManifest(manifest: BoxManifest, state: BoxState): BoxStatus {
		return {
			boxId: manifest.boxId,
			ownerId: manifest.ownerId,
			...(manifest.originSessionId ? { originSessionId: manifest.originSessionId } : {}),
			attachments: manifest.attachments,
			projectCwd: manifest.projectCwd,
			workspace: manifest.workspacePath,
			state,
			settings: manifest.settings,
			createdAt: manifest.createdAt,
			lastUsedAt: manifest.lastUsedAt,
			...(manifest.pausedAt ? { pausedAt: manifest.pausedAt } : {}),
			...(manifest.error ? { error: manifest.error } : {}),
		};
	}

	private async pauseInternal(boxId: string): Promise<void> {
		const manifest = this.requireManifest(boxId);
		const resident = this.resident.get(boxId);
		if (!resident) return;
		await this.schedulerLock.run(() => {
			if (resident.leases > 0) throw new BoxError({ message: "Cannot pause a box while a run is using it" });
			resident.stopping = true;
		});
		try {
			await this.runtime.pause(manifest.sandboxName);
			await this.schedulerLock.run(() => {
				resident.state = "paused";
				resident.pausedAt = Date.now();
				resident.stopping = false;
			});
			const pausedAt = new Date().toISOString();
			await this.updateManifest(boxId, (current) => ({
				...current,
				state: "paused",
				pausedAt,
				lastUsedAt: current.lastUsedAt,
			}));
		} catch (error) {
			console.warn(`relay box: pause failed for ${boxId}; stopping instead: ${toBoxError(error).message}`);
			await this.stopResident(boxId, resident);
		} finally {
			this.schedulePump();
		}
	}

	private async resumeInternal(boxId: string): Promise<void> {
		const manifest = this.requireManifest(boxId);
		const resident = this.resident.get(boxId);
		if (!resident || resident.state !== "paused") {
			throw new BoxError({ message: "Box is not paused" });
		}
		await this.schedulerLock.run(() => {
			resident.stopping = true;
		});
		try {
			await this.runtime.resume(manifest.sandboxName);
			await this.schedulerLock.run(() => {
				resident.state = "ready";
				resident.pausedAt = null;
				resident.stopping = false;
				resident.lastUsedAt = Date.now();
			});
			await this.updateManifest(boxId, (current) => {
				const ready = { ...current, state: "ready" as const, lastUsedAt: new Date().toISOString() };
				delete ready.pausedAt;
				return ready;
			});
		} catch (error) {
			await this.schedulerLock.run(() => {
				resident.stopping = false;
			});
			throw error;
		} finally {
			this.schedulePump();
		}
	}

	private async stopInternal(boxId: string): Promise<void> {
		const manifest = this.store.load(boxId);
		if (!manifest) return;
		const resident = this.resident.get(boxId);
		if (!resident) {
			try {
				await this.runtime.stop(manifest.sandboxName);
			} catch (error) {
				throw toBoxError(error, `Could not stop box ${boxId}`);
			}
			await this.updateManifest(boxId, (current) => this.stoppedManifest(current));
			this.evictionFailures.delete(boxId);
			return;
		}
		await this.schedulerLock.run(() => {
			if (resident.leases > 0) throw new BoxError({ message: "Cannot stop a box while a run is using it" });
			resident.stopping = true;
		});
		await this.stopResident(boxId, resident);
	}

	private async stopResident(boxId: string, resident: Resident): Promise<void> {
		const manifest = this.store.load(boxId);
		try {
			if (manifest) await this.runtime.stop(manifest.sandboxName);
			if (manifest) {
				await this.updateManifest(boxId, (current) => this.stoppedManifest(current));
			}
			await this.schedulerLock.run(() => {
				this.resident.delete(boxId);
			});
			this.evictionFailures.delete(boxId);
		} catch (error) {
			await this.schedulerLock.run(() => {
				resident.stopping = false;
			});
			throw error;
		} finally {
			this.schedulePump();
		}
	}

	private async destroyInternal(boxId: string): Promise<void> {
		const manifest = this.store.load(boxId);
		if (!manifest) return;
		if (manifest.attachments.length > 0) {
			throw new BoxError({ message: "Detach all sessions before removing a box" });
		}
		const resident = this.resident.get(boxId);
		if (resident) {
			await this.schedulerLock.run(() => {
				if (resident.leases > 0) throw new BoxError({ message: "Cannot remove a box while a run is using it" });
				resident.stopping = true;
			});
		}
		try {
			await this.runtime.destroy(manifest.sandboxName);
			await this.withManifestLock(boxId, () => {
				const current = this.store.load(boxId);
				if (!current) return;
				if (current.attachments.length > 0) {
					throw new BoxError({ message: "Detach all sessions before removing a box" });
				}
				this.store.trash(current);
			});
			await this.schedulerLock.run(() => {
				this.resident.delete(boxId);
			});
			this.evictionFailures.delete(boxId);
		} catch (error) {
			if (resident) {
				await this.schedulerLock.run(() => {
					resident.stopping = false;
				});
			}
			throw error;
		} finally {
			this.schedulePump();
		}
	}

	private async resizeInternal(boxId: string, profile: BoxProfile): Promise<BoxStatus> {
		const manifest = this.requireManifest(boxId);
		if (profileRank(profile) > profileRank(manifest.settings.maxProfile)) {
			throw new BoxError({ message: `This box is limited to the ${manifest.settings.maxProfile} profile` });
		}
		if (profileRank(profile) > profileRank(this.config.maxProfile)) {
			throw new BoxError({ message: `The server allows at most the ${this.config.maxProfile} profile` });
		}
		const resources = profileResources(profile);
		const rootDiskMiB = Math.max(manifest.settings.rootDiskMiB, resources.rootDiskMiB);
		const settings: BoxSettings = {
			...manifest.settings,
			profile,
			cpus: resources.cpus,
			memoryMiB: resources.memoryMiB,
			rootDiskMiB,
		};
		const resident = this.resident.get(boxId);
		if (!resident) {
			const updated = await this.updateManifest(boxId, (current) => ({ ...current, settings }));
			if (!updated) throw new BoxError({ message: `Box ${boxId} disappeared` });
			const status = await this.statusInternal(boxId, updated);
			if (!status) throw new BoxError({ message: `Box ${boxId} disappeared` });
			return status;
		}
		if (resident.state === "paused") {
			throw new BoxError({ message: "Resume the box before resizing it" });
		}
		if (resident.state === "starting") {
			throw new BoxError({ message: "The box is still starting" });
		}

		const nextResources = { cpus: resources.cpus, memoryMiB: resources.memoryMiB };
		const unchanged =
			resident.resources.cpus === nextResources.cpus &&
			resident.resources.memoryMiB === nextResources.memoryMiB &&
			manifest.settings.rootDiskMiB === rootDiskMiB;
		if (unchanged) {
			const updated = await this.updateManifest(boxId, (current) => ({
				...current,
				settings,
				lastUsedAt: new Date().toISOString(),
			}));
			if (!updated) throw new BoxError({ message: `Box ${boxId} disappeared` });
			const status = await this.statusInternal(boxId, updated);
			if (!status) throw new BoxError({ message: `Box ${boxId} disappeared` });
			return status;
		}

		const deltaCpus = nextResources.cpus - resident.resources.cpus;
		const deltaMemory = nextResources.memoryMiB - resident.resources.memoryMiB;
		let reserved = false;
		if (deltaCpus > 0 || deltaMemory > 0) {
			// Evict idle boxes one at a time until the resize fits or nothing else
			// can be reclaimed. Never evict the box being resized, and never retry
			// a victim whose stop just failed.
			const attempted = new Set<string>();
			while (!reserved) {
				await this.schedulerLock.run(() => {
					let cpus = 0;
					let memory = 0;
					for (const entry of this.resident.values()) {
						cpus += entry.resources.cpus;
						memory += entry.resources.memoryMiB + this.config.vmOverheadMiB;
					}
					if (
						cpus + Math.max(0, deltaCpus) <= this.config.maxCpus &&
						memory + Math.max(0, deltaMemory) <= this.config.maxMemoryMiB
					) {
						resident.resources = nextResources;
						reserved = true;
					}
				});
				if (reserved) break;
				const victim = await this.pickAndEvictVictim(boxId, attempted);
				if (!victim) {
					throw new BoxError({
						message: `Not enough box capacity for ${profile}; stop or shrink another box first`,
					});
				}
			}
		} else {
			await this.schedulerLock.run(() => {
				resident.resources = nextResources;
			});
		}

		try {
			const result = await this.runtime.modify(manifest.sandboxName, {
				cpus: resources.cpus,
				memoryMiB: resources.memoryMiB,
				rootDiskMiB,
			});
			this.assertResizeApplied(result);
			const updated = await this.updateManifest(boxId, (current) => ({
				...current,
				settings,
				lastUsedAt: new Date().toISOString(),
			}));
			if (!updated) throw new BoxError({ message: `Box ${boxId} disappeared` });
			await this.schedulerLock.run(() => {
				resident.resources = nextResources;
			});
			const status = await this.statusInternal(boxId, updated);
			if (!status) throw new BoxError({ message: `Box ${boxId} disappeared` });
			return status;
		} catch (error) {
			await this.schedulerLock.run(() => {
				resident.resources = { cpus: manifest.settings.cpus, memoryMiB: manifest.settings.memoryMiB };
			});
			throw error;
		}
	}

	private assertResizeApplied(result: RuntimeResizeResult): void {
		const failed = result.resizeStatus.find(
			(status) => status.state === "failed" || status.state === "guest-refused",
		);
		if (failed) {
			throw new BoxError({
				message: `Could not resize ${failed.resource} to ${failed.requested}: ${failed.state}`,
			});
		}
		if (!result.applied && result.resizeStatus.length > 0) {
			throw new BoxError({ message: `Box resize was not applied (status: ${result.status})` });
		}
	}

	private async pickAndEvictVictim(
		excludeBoxId?: string,
		attempted: Set<string> = new Set(),
	): Promise<string | null> {
		for (;;) {
			const victim = await this.schedulerLock.run(() => {
				const selected = this.pickVictim(excludeBoxId, attempted);
				if (selected) selected.stopping = true;
				return selected;
			});
			if (!victim) return null;
			if (await this.evict(victim.boxId)) return victim.boxId;
			attempted.add(victim.boxId);
		}
	}

	private async detachSessionsInternal(sessionIds: ReadonlySet<string>): Promise<number> {
		let detached = 0;
		for (const manifest of this.store.list()) {
			const resident = this.resident.get(manifest.boxId);
			if (resident && resident.leases > 0) continue;
			let removed = 0;
			const updated = await this.updateManifest(manifest.boxId, (current) => {
				const attachments = current.attachments.filter((attachment) => !sessionIds.has(attachment.sessionId));
				if (attachments.length === current.attachments.length) return null;
				removed = current.attachments.length - attachments.length;
				return { ...current, attachments };
			});
			if (updated && removed > 0) detached += removed;
		}
		return detached;
	}

	private async gcInternal(activeSessionIds: ReadonlySet<string>): Promise<GcResult> {
		let detached = 0;
		for (const manifest of this.store.list()) {
			const resident = this.resident.get(manifest.boxId);
			if (resident && resident.leases > 0) continue;
			let removed = 0;
			const updated = await this.updateManifest(manifest.boxId, (current) => {
				const attachments = current.attachments.filter((attachment) =>
					activeSessionIds.has(attachment.sessionId),
				);
				if (attachments.length === current.attachments.length) return null;
				removed = current.attachments.length - attachments.length;
				return { ...current, attachments };
			});
			if (updated && removed > 0) detached += removed;
		}

		const trashed = await this.collectExpiredInternal();
		const removed = this.store.removeTrash(TRASH_TTL_MS);
		return { removed, trashed, detached };
	}

	/**
	 * Trash boxes whose retention elapsed. Retention applies to attached boxes
	 * too: a session keeps its box warm for a while, then the next message
	 * creates a fresh one. Active leases are never collected.
	 */
	private async collectExpiredInternal(): Promise<number> {
		if (this.config.retentionMs <= 0) return 0;
		const cutoff = Date.now() - this.config.retentionMs;
		let trashed = 0;
		for (const manifest of this.store.list()) {
			try {
				const removed = await this.withBoxLock(manifest.boxId, async () => {
					const resident = this.resident.get(manifest.boxId);
					if (resident && (resident.leases > 0 || resident.stopping)) return false;
					const current = this.store.load(manifest.boxId);
					if (!current) return false;
					const lastUsed = Date.parse(current.lastUsedAt);
					if (!Number.isFinite(lastUsed) || lastUsed > cutoff) return false;
					if (resident) await this.stopInternal(manifest.boxId);
					const stopped = await this.updateManifest(manifest.boxId, (current) =>
						current.attachments.length === 0 ? null : { ...current, attachments: [] },
					);
					if (!stopped) return false;
					await this.destroyInternal(manifest.boxId);
					return true;
				});
				if (removed) trashed += 1;
			} catch (error) {
				console.warn(`relay box: could not collect ${manifest.boxId}: ${toBoxError(error).message}`);
			}
		}
		return trashed;
	}

	private async reconcileInternal(): Promise<void> {
		for (const manifest of this.store.list()) {
			cleanupTempWorkspaces(this.store.dir(manifest.boxId));
		}
		const failedStops = new Set<string>();
		let listed = false;
		try {
			const boxes = await this.runtime.list(this.labelsForList());
			listed = true;
			for (const box of boxes) {
				if (box.status === "stopped" || box.status === "absent" || box.status === "crashed") continue;
				try {
					await this.runtime.stop(box.name);
				} catch (error) {
					failedStops.add(box.name);
					console.warn(
						`relay box: could not stop ${box.name} during reconcile: ${toBoxError(error).message}`,
					);
				}
			}
		} catch (error) {
			console.warn(`relay box: reconcile could not list sandboxes: ${toBoxError(error).message}`);
		}
		await this.schedulerLock.run(() => {
			this.resident.clear();
		});
		this.evictionFailures.clear();
		if (listed) {
			for (const manifest of this.store.list()) {
				if (manifest.state === "error") continue;
				if (failedStops.has(manifest.sandboxName)) {
					// Keep the state non-terminal so status still probes the runtime
					// instead of claiming a VM we failed to stop is stopped.
					await this.updateManifest(manifest.boxId, (current) => this.withState(current, "ready"));
					continue;
				}
				await this.updateManifest(manifest.boxId, (current) => this.stoppedManifest(current));
			}
		}
		this.rebuildSessionIndex();
		this.schedulePump();
	}

	private async shutdownInternal(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		this.sweepTimer = null;
		for (const boxId of [...this.resident.keys()]) {
			const manifest = this.store.load(boxId);
			try {
				if (manifest) await this.runtime.stop(manifest.sandboxName);
				if (manifest) {
					await this.updateManifest(boxId, (current) => this.stoppedManifest(current));
				}
			} catch (error) {
				console.warn(`relay box: could not stop ${boxId}: ${toBoxError(error).message}`);
			}
			await this.schedulerLock.run(() => {
				this.resident.delete(boxId);
			});
		}
		this.releaseLock();
	}

	private async sweep(): Promise<void> {
		if (this.sweeping || this.shuttingDown) return;
		this.sweeping = true;
		try {
			const now = Date.now();
			const toPause: string[] = [];
			const toStop: string[] = [];
			await this.schedulerLock.run(() => {
				for (const [boxId, resident] of this.resident) {
					if (resident.leases > 0 || resident.stopping) continue;
					if (resident.state === "ready") {
						if (this.config.stopMs > 0 && now - resident.lastUsedAt >= this.config.stopMs)
							toStop.push(boxId);
						else if (this.config.pauseMs > 0 && now - resident.lastUsedAt >= this.config.pauseMs)
							toPause.push(boxId);
					} else if (resident.state === "paused" && resident.pausedAt !== null) {
						if (this.config.stopMs > 0 && now - resident.pausedAt >= this.config.stopMs) toStop.push(boxId);
					}
				}
			});
			for (const boxId of toPause) {
				try {
					await this.pauseInternal(boxId);
				} catch (error) {
					console.warn(`relay box: idle pause failed for ${boxId}: ${toBoxError(error).message}`);
				}
			}
			for (const boxId of toStop) {
				try {
					await this.stopInternal(boxId);
				} catch (error) {
					console.warn(`relay box: idle stop failed for ${boxId}: ${toBoxError(error).message}`);
				}
			}

			if (now - this.lastGcAt >= GC_INTERVAL_MS) {
				this.lastGcAt = now;
				try {
					const trashed = await this.collectExpiredInternal();
					const removed = this.store.removeTrash(TRASH_TTL_MS);
					if (trashed > 0 || removed > 0) {
						console.log(`Box GC: trashed ${trashed}, removed ${removed} expired workspace(s).`);
					}
				} catch (error) {
					console.warn(`relay box: periodic GC failed: ${toBoxError(error).message}`);
				}
			}
		} finally {
			this.sweeping = false;
		}
	}

	private nextBoxId(): string {
		for (;;) {
			const boxId = createBoxId();
			if (!this.store.load(boxId) && !existsSync(boxDir(this.config.dataDir, boxId))) return boxId;
		}
	}

	/** Clamp a requested profile and its exact overrides to the server ceiling. */
	private normalizeSettings(settings: BoxSettings): BoxSettings {
		const maxProfile =
			profileRank(settings.maxProfile) > profileRank(this.config.maxProfile)
				? this.config.maxProfile
				: settings.maxProfile;
		const profile = profileRank(settings.profile) > profileRank(maxProfile) ? maxProfile : settings.profile;
		const resources = profileResources(maxProfile);
		return {
			...settings,
			profile,
			maxProfile,
			cpus: Math.min(settings.cpus, resources.cpus),
			memoryMiB: Math.min(settings.memoryMiB, resources.memoryMiB),
			rootDiskMiB: Math.min(settings.rootDiskMiB, resources.rootDiskMiB),
		};
	}

	/**
	 * Pick the prepared tool image when it is loaded, otherwise the plain Node
	 * image. `RELAY_BOX_IMAGE` bypasses this by setting a concrete reference.
	 */
	private async resolveImage(): Promise<string> {
		try {
			const images = await this.runtime.listImages();
			if (images.includes(PREPARED_BOX_IMAGE)) return PREPARED_BOX_IMAGE;
			const prepared = images.filter((reference) => isPreparedBoxImage(reference)).sort();
			if (prepared.length > 0) return prepared[prepared.length - 1] as string;
		} catch {
			// Missing runtime/KVM must not prevent the fallback image from working.
			return "node:26-bookworm";
		}
		if (!this.imageFallbackWarned) {
			this.imageFallbackWarned = true;
			console.warn(
				"relay box: prepared relay-box:local is not loaded; using node:26-bookworm. " +
					"Run `pnpm box:image` to enable embedded Playwright/browser tools.",
			);
		}
		return "node:26-bookworm";
	}

	private requireManifest(boxId: string): BoxManifest {
		const manifest = this.store.load(boxId);
		if (!manifest) throw new BoxError({ message: `No box found: ${boxId}` });
		return manifest;
	}

	private manifestForSession(sessionId: string): BoxManifest | null {
		const ids = this.sessionIndex.get(sessionId);
		if (!ids || ids.size === 0) return null;
		let best: BoxManifest | null = null;
		for (const boxId of ids) {
			const manifest = this.store.load(boxId);
			if (!manifest || !manifest.attachments.some((attachment) => attachment.sessionId === sessionId)) {
				this.unindexSession(sessionId, boxId);
				continue;
			}
			if (!best || manifest.lastUsedAt > best.lastUsedAt) best = manifest;
		}
		return best;
	}

	private rebuildSessionIndex(): void {
		this.sessionIndex.clear();
		for (const manifest of this.store.list()) this.indexManifest(manifest);
	}

	private indexManifest(manifest: BoxManifest): void {
		for (const attachment of manifest.attachments) this.indexSession(attachment.sessionId, manifest.boxId);
	}

	private indexSession(sessionId: string, boxId: string): void {
		let ids = this.sessionIndex.get(sessionId);
		if (!ids) {
			ids = new Set();
			this.sessionIndex.set(sessionId, ids);
		}
		ids.add(boxId);
	}

	private unindexSession(sessionId: string, boxId: string): void {
		const ids = this.sessionIndex.get(sessionId);
		if (!ids) return;
		ids.delete(boxId);
		if (ids.size === 0) this.sessionIndex.delete(sessionId);
	}

	private syncSessionIndex(previous: BoxManifest, next: BoxManifest): void {
		const before = new Set(previous.attachments.map((attachment) => attachment.sessionId));
		const after = new Set(next.attachments.map((attachment) => attachment.sessionId));
		for (const sessionId of before) {
			if (!after.has(sessionId)) this.unindexSession(sessionId, next.boxId);
		}
		for (const sessionId of after) {
			if (!before.has(sessionId)) this.indexSession(sessionId, next.boxId);
		}
	}

	private async attachInternal(boxId: string, sessionId: string): Promise<void> {
		await this.updateManifest(boxId, (manifest) => {
			if (manifest.attachments.some((attachment) => attachment.sessionId === sessionId)) return null;
			return {
				...manifest,
				attachments: [...manifest.attachments, { sessionId, attachedAt: new Date().toISOString() }],
				lastUsedAt: new Date().toISOString(),
			};
		});
	}

	/**
	 * Serializes whole-manifest read-modify-write cycles. Runtime calls must stay
	 * outside this lock; it is a leaf lock so it can be taken after the box and
	 * scheduler locks without inverting their order.
	 */
	private withManifestLock<T>(boxId: string, fn: () => T): Promise<T> {
		let mutex = this.manifestLocks.get(boxId);
		if (!mutex) {
			mutex = new Mutex();
			this.manifestLocks.set(boxId, mutex);
		}
		return mutex.run(fn);
	}

	private async updateManifest(
		boxId: string,
		mutate: (manifest: BoxManifest) => BoxManifest | null,
	): Promise<BoxManifest | null> {
		return await this.withManifestLock(boxId, () => {
			const current = this.store.load(boxId);
			if (!current) return null;
			const next = mutate(current);
			if (!next) return current;
			this.store.write(next);
			this.syncSessionIndex(current, next);
			return next;
		});
	}

	private async markBoxError(boxId: string, message: string): Promise<void> {
		await this.updateManifest(boxId, (current) => this.withState(current, "error", message));
	}

	private withBoxLock<T>(boxId: string, fn: () => Promise<T>): Promise<T> {
		let mutex = this.boxesLock.get(boxId);
		if (!mutex) {
			mutex = new Mutex();
			this.boxesLock.set(boxId, mutex);
		}
		return mutex.run(fn);
	}

	private withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
		let mutex = this.sessionsLock.get(sessionId);
		if (!mutex) {
			mutex = new Mutex();
			this.sessionsLock.set(sessionId, mutex);
		}
		return mutex.run(fn);
	}

	private labels(boxId: string): Record<string, string> {
		return {
			"relay.box": boxId,
			"relay.dataDir": dataDirHash(this.config.dataDir),
		};
	}

	private labelsForList(): Record<string, string> {
		return { "relay.dataDir": dataDirHash(this.config.dataDir) };
	}

	private stoppedManifest(manifest: BoxManifest): BoxManifest {
		const next = {
			...manifest,
			state: "stopped" as const,
			lastUsedAt: new Date().toISOString(),
		};
		delete next.pausedAt;
		return next;
	}

	private withState(manifest: BoxManifest, state: BoxState, error?: string): BoxManifest {
		const next: BoxManifest = {
			...manifest,
			state,
			lastUsedAt: new Date().toISOString(),
		};
		if (state !== "paused") delete next.pausedAt;
		if (error) next.error = error;
		else delete next.error;
		return next;
	}
}

function isPathInside(child: string, parent: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function createBoxManager(config: BoxManagerConfig, runtime?: BoxRuntime): BoxManager {
	if (!config.enabled) return new DisabledBoxManager();
	return new BoxManagerImpl(config, runtime);
}
