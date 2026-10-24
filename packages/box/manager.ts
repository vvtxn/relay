import { existsSync, mkdirSync } from "node:fs";
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
	ExecOptions,
	ExecResult,
	GcResult,
	RuntimeResizeResult,
	RuntimeStatus,
} from "./types.ts";

const SWEEP_INTERVAL_MS = 30_000;
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

	constructor(manager: BoxManagerImpl, status: BoxStatus, workspace: string) {
		this.manager = manager;
		this.boxId = status.boxId;
		this.status = status;
		this.workspace = workspace;
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

	list(): Effect.Effect<BoxStatus[], BoxError> {
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
	private readonly schedulerLock = new Mutex();
	private readonly queue: PendingAcquire[] = [];
	private readonly sessionIndex = new Map<string, Set<string>>();
	private sweepTimer: NodeJS.Timeout | null = null;
	private sweeping = false;
	private shuttingDown = false;
	private pumpScheduled = false;
	private imageFallbackWarned = false;

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
				await this.withBoxLock(boxId, () => this.createManifest(normalized, boxId));
				const status = await this.statusInternal(boxId);
				if (!status) throw new BoxError({ message: `Box ${boxId} disappeared after creation` });
				return status;
			},
			catch: (error) => toBoxError(error, "Could not create box"),
		});
	}

	acquire(spec: BoxSpec): Effect.Effect<BoxLease, BoxError> {
		return Effect.tryPromise({
			try: () => this.acquireInternal(spec),
			catch: (error) => toBoxError(error, "Could not acquire box"),
		});
	}

	findBySession(sessionId: string): Effect.Effect<BoxStatus | null, BoxError> {
		return Effect.tryPromise({
			try: async () => {
				const manifest = this.manifestForSession(sessionId);
				return manifest ? await this.statusInternal(manifest.boxId) : null;
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

	list(): Effect.Effect<BoxStatus[], BoxError> {
		return Effect.tryPromise({
			try: async () => {
				const statuses: BoxStatus[] = [];
				for (const manifest of this.store.list()) {
					const status = await this.statusInternal(manifest.boxId);
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
					await this.attachInternal(this.requireManifest(boxId), sessionId);
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
					const manifest = this.requireManifest(boxId);
					if (!manifest.attachments.some((attachment) => attachment.sessionId === sessionId)) return;
					const next: BoxManifest = {
						...manifest,
						attachments: manifest.attachments.filter((attachment) => attachment.sessionId !== sessionId),
					};
					this.store.write(next);
					this.unindexSession(sessionId, boxId);
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
			try: () => this.resizeInternal(boxId, profile),
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
			try: async () => {
				const manifest = this.store.load(boxId);
				if (!manifest) throw new BoxError({ message: `No box found: ${boxId}` });
				const resident = this.resident.get(boxId);
				if (!resident || resident.state === "paused") {
					throw new BoxError({ message: `Box ${boxId} is not running` });
				}
				return await this.runtime.exec(manifest.sandboxName, command, {
					cwd: options.cwd ?? "/workspace",
					env: boxExecEnv(manifest.settings, options.env),
					timeoutMs: options.timeoutMs ?? 30_000,
					...(options.signal ? { signal: options.signal } : {}),
				});
			},
			catch: (error) => toBoxError(error, "Command failed"),
		});
	}

	async release(boxId: string): Promise<void> {
		await this.schedulerLock.run(() => {
			const resident = this.resident.get(boxId);
			if (!resident) return;
			resident.leases = Math.max(0, resident.leases - 1);
			if (resident.leases === 0) {
				resident.state = "ready";
				resident.lastUsedAt = Date.now();
			}
		});
		const manifest = this.store.load(boxId);
		if (manifest) {
			this.store.write({ ...manifest, state: "ready", lastUsedAt: new Date().toISOString() });
		}
		this.schedulePump();
	}

	private async acquireInternal(spec: BoxSpec): Promise<BoxLease> {
		const key = spec.sessionId ?? `standalone:${createBoxId()}`;
		return await this.withSessionLock(key, async () => {
			if (spec.signal?.aborted) throw new BoxError({ message: "Box acquisition was cancelled" });
			let manifest = spec.sessionId ? this.manifestForSession(spec.sessionId) : null;
			if (manifest && manifest.ownerId !== spec.ownerId) {
				throw new BoxError({ message: "This box belongs to a different user" });
			}
			const isNew = manifest === null;
			const boxId = manifest?.boxId ?? this.nextBoxId();
			const settings = this.normalizeSettings(manifest?.settings ?? spec.settings);
			const resources = { cpus: settings.cpus, memoryMiB: settings.memoryMiB };

			await this.waitForGrant({
				boxId,
				spec: { ...spec, settings },
				resources,
				isNew,
				...(spec.signal ? { signal: spec.signal } : {}),
			});
			if (spec.signal?.aborted) {
				await this.releaseReservation(boxId, true);
				throw new BoxError({ message: "Box acquisition was cancelled" });
			}

			try {
				manifest = isNew
					? await this.withBoxLock(boxId, () => this.createManifest(spec, boxId))
					: this.requireManifest(boxId);
				await this.withBoxLock(boxId, () => this.startBox(manifest as BoxManifest));
				const status = await this.statusInternal(boxId);
				if (!status) throw new BoxError({ message: `Box ${boxId} disappeared during startup` });
				return new Lease(this, status, status.workspace);
			} catch (error) {
				const failed = this.store.load(boxId);
				if (failed) {
					await this.runtime.stop(failed.sandboxName).catch(() => {});
					this.store.write({ ...failed, state: "error", error: toBoxError(error).message });
				}
				await this.releaseReservation(boxId, true);
				throw toBoxError(error, "Could not start box");
			}
		});
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
			};
			const onAbort = (): void => fail(new BoxError({ message: "Box acquisition was cancelled" }));
			pending.cleanup = cleanup;
			pending.timer = setTimeout(
				() => fail(new BoxError({ message: "Timed out waiting for box capacity" })),
				this.config.acquireTimeoutMs,
			);
			pending.timer.unref();
			pending.signal?.addEventListener("abort", onAbort, { once: true });
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
					if (resident.stopping) break;
					if (resident.leases > 0) break;
					resident.leases = 1;
					resident.state = "busy";
					resident.lastUsedAt = Date.now();
					this.queue.splice(index, 1);
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
				grants.push(pending);
			}
		});
		for (const pending of grants) {
			pending.settled = true;
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

	private pickVictim(excludeBoxId?: string): Resident | null {
		let victim: Resident | null = null;
		for (const resident of this.resident.values()) {
			if (resident.boxId === excludeBoxId) continue;
			if (resident.leases > 0 || resident.stopping) continue;
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

	private async evict(boxId: string): Promise<void> {
		const manifest = this.store.load(boxId);
		try {
			if (manifest) await this.runtime.stop(manifest.sandboxName);
			await this.schedulerLock.run(() => {
				this.resident.delete(boxId);
			});
			if (manifest) {
				this.store.write({ ...manifest, state: "stopped", lastUsedAt: new Date().toISOString() });
			}
		} catch (error) {
			console.warn(`relay box: could not evict ${boxId}: ${toBoxError(error).message}`);
			await this.schedulerLock.run(() => {
				const resident = this.resident.get(boxId);
				if (resident) resident.stopping = false;
			});
		} finally {
			this.schedulePump();
		}
	}

	private async releaseReservation(boxId: string, remove: boolean): Promise<void> {
		await this.schedulerLock.run(() => {
			const resident = this.resident.get(boxId);
			if (!resident) return;
			resident.leases = Math.max(0, resident.leases - 1);
			if (remove || resident.leases === 0) {
				this.resident.delete(boxId);
				return;
			}
			resident.state = "ready";
			resident.lastUsedAt = Date.now();
		});
		this.schedulePump();
	}

	private async createManifest(spec: BoxSpec, boxId: string): Promise<BoxManifest> {
		const normalized = this.normalizeSettings(spec.settings);
		const settings = normalized.image === "auto" ? { ...normalized, image: await this.resolveImage() } : normalized;
		const dir = boxDir(this.config.dataDir, boxId);
		const workspace = workspacePath(this.config.dataDir, boxId);
		if (isPathInside(spec.projectCwd, this.config.dataDir)) {
			throw new BoxError({ message: "The project directory must not be inside the box data directory" });
		}
		ensureBoxDirs(this.config.dataDir, boxId);
		cleanupTempWorkspaces(dir);
		if (!existsSync(workspace)) {
			await prepareWorkspace(spec.projectCwd, dir, workspace, settings.exclude);
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
		this.indexManifest(manifest);
		console.log(`relay box: created ${boxId} at ${workspace}`);
		return manifest;
	}

	private async startBox(initial: BoxManifest): Promise<BoxManifest> {
		let manifest = initial;
		if (manifest.settings.image === "auto") {
			manifest = { ...manifest, settings: { ...manifest.settings, image: await this.resolveImage() } };
			this.store.write(manifest);
		}
		if (!existsSync(manifest.workspacePath)) {
			const failed = this.withState(manifest, "error", "Box workspace is missing");
			this.store.write(failed);
			throw new BoxError({ message: `Box workspace is missing: ${manifest.workspacePath}` });
		}

		const before = await this.runtime.status(manifest.sandboxName);
		let coldStart = false;
		if (before === "paused") {
			await this.runtime.resume(manifest.sandboxName);
		} else {
			const needsStart = before !== "running" && before !== "starting" && before !== "draining";
			if (before === "absent") {
				try {
					await this.runtime.create({
						name: manifest.sandboxName,
						settings: manifest.settings,
						workspace: manifest.workspacePath,
						cacheDir: this.config.cacheDir,
						labels: this.labels(manifest.boxId),
						secrets: this.config.secrets,
						maxCpus: this.config.maxCpus,
						maxMemoryMiB: this.config.maxMemoryMiB,
					});
					coldStart = true;
				} catch (error) {
					const current = await this.runtime.status(manifest.sandboxName).catch(() => "absent" as const);
					if (current !== "absent") {
						await this.runtime.start(manifest.sandboxName);
						coldStart = true;
					} else {
						const failed = this.withState(manifest, "error", toBoxError(error).message);
						this.store.write(failed);
						throw error;
					}
				}
			} else if (needsStart) {
				try {
					await this.runtime.start(manifest.sandboxName);
					coldStart = true;
				} catch (error) {
					if (before === "crashed") {
						await this.runtime.destroy(manifest.sandboxName).catch(() => {});
						await this.runtime.create({
							name: manifest.sandboxName,
							settings: manifest.settings,
							workspace: manifest.workspacePath,
							cacheDir: this.config.cacheDir,
							labels: this.labels(manifest.boxId),
							secrets: this.config.secrets,
							maxCpus: this.config.maxCpus,
							maxMemoryMiB: this.config.maxMemoryMiB,
						});
						coldStart = true;
					} else {
						const failed = this.withState(manifest, "error", toBoxError(error).message);
						this.store.write(failed);
						throw error;
					}
				}
			}
		}

		if (manifest.setupState !== "ok" && manifest.settings.setup) {
			const setupState = await this.runHook(manifest, "setup", manifest.settings.setup, true);
			manifest = { ...manifest, setupState };
			this.store.write(manifest);
			if (setupState === "failed") {
				const failed = this.withState(manifest, "error", "Box setup failed; see logs/setup.log");
				this.store.write(failed);
				throw new BoxError({ message: "Box setup failed; see logs/setup.log" });
			}
		}
		if (manifest.setupState === "pending" && !manifest.settings.setup) {
			manifest = { ...manifest, setupState: "ok" };
		}
		if (manifest.setupState === "failed") {
			const failed = this.withState(manifest, "error", "Box setup failed; see logs/setup.log");
			this.store.write(failed);
			throw new BoxError({ message: "Box setup failed; see logs/setup.log" });
		}

		if (coldStart && manifest.settings.resume) {
			await this.runHook(manifest, "resume", manifest.settings.resume, false);
		}

		const ready = this.withState(manifest, "busy");
		delete ready.pausedAt;
		this.store.write(ready);
		await this.schedulerLock.run(() => {
			const resident = this.resident.get(manifest.boxId);
			if (resident) {
				resident.state = "busy";
				resident.pausedAt = null;
				resident.stopping = false;
				resident.lastUsedAt = Date.now();
			}
		});
		return ready;
	}

	private async runHook(
		manifest: BoxManifest,
		name: "setup" | "resume",
		command: string,
		fatal: boolean,
	): Promise<SetupState> {
		const result = await this.runtime.exec(manifest.sandboxName, command, {
			cwd: "/workspace",
			env: boxExecEnv(manifest.settings),
			timeoutMs: this.config.setupTimeoutMs,
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

	private async statusInternal(boxId: string): Promise<BoxStatus | null> {
		const manifest = this.store.load(boxId);
		if (!manifest) return null;
		let runtimeStatus: RuntimeStatus = "absent";
		try {
			runtimeStatus = await this.runtime.status(manifest.sandboxName);
		} catch {
			runtimeStatus = manifest.state === "error" ? "crashed" : "absent";
		}
		const resident = this.resident.get(boxId);
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
			this.store.write({ ...manifest, state: "paused", pausedAt, lastUsedAt: manifest.lastUsedAt });
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
			const ready = { ...manifest, state: "ready" as const, lastUsedAt: new Date().toISOString() };
			delete ready.pausedAt;
			this.store.write(ready);
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
			await this.runtime.stop(manifest.sandboxName).catch(() => {});
			this.store.write({ ...manifest, state: "stopped", lastUsedAt: new Date().toISOString() });
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
			await this.schedulerLock.run(() => {
				this.resident.delete(boxId);
			});
			if (manifest) {
				this.store.write({ ...manifest, state: "stopped", lastUsedAt: new Date().toISOString() });
			}
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
			await this.schedulerLock.run(() => {
				this.resident.delete(boxId);
			});
			this.store.trash(manifest);
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
			this.store.write({ ...manifest, settings });
			const status = await this.statusInternal(boxId);
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
			this.store.write({ ...manifest, settings, lastUsedAt: new Date().toISOString() });
			const status = await this.statusInternal(boxId);
			if (!status) throw new BoxError({ message: `Box ${boxId} disappeared` });
			return status;
		}

		const deltaCpus = nextResources.cpus - resident.resources.cpus;
		const deltaMemory = nextResources.memoryMiB - resident.resources.memoryMiB;
		let reserved = false;
		if (deltaCpus > 0 || deltaMemory > 0) {
			// Evict idle boxes one at a time until the resize fits or nothing else
			// can be reclaimed. Never evict the box being resized.
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
				const victim = await this.pickAndEvictVictim(boxId);
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
			const updated = { ...manifest, settings, lastUsedAt: new Date().toISOString() };
			this.store.write(updated);
			await this.schedulerLock.run(() => {
				resident.resources = nextResources;
			});
		} catch (error) {
			await this.schedulerLock.run(() => {
				resident.resources = { cpus: manifest.settings.cpus, memoryMiB: manifest.settings.memoryMiB };
			});
			throw error;
		}
		const status = await this.statusInternal(boxId);
		if (!status) throw new BoxError({ message: `Box ${boxId} disappeared` });
		return status;
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

	private async pickAndEvictVictim(excludeBoxId?: string): Promise<string | null> {
		let victim: Resident | null = null;
		await this.schedulerLock.run(() => {
			victim = this.pickVictim(excludeBoxId);
			if (victim) victim.stopping = true;
		});
		if (!victim) return null;
		const boxId = (victim as Resident).boxId;
		await this.evict(boxId);
		return boxId;
	}

	private async detachSessionsInternal(sessionIds: ReadonlySet<string>): Promise<number> {
		let detached = 0;
		for (const manifest of this.store.list()) {
			const resident = this.resident.get(manifest.boxId);
			if (resident && resident.leases > 0) continue;
			const attachments = manifest.attachments.filter((attachment) => !sessionIds.has(attachment.sessionId));
			if (attachments.length === manifest.attachments.length) continue;
			for (const attachment of manifest.attachments) {
				if (sessionIds.has(attachment.sessionId)) this.unindexSession(attachment.sessionId, manifest.boxId);
			}
			this.store.write({ ...manifest, attachments });
			detached += manifest.attachments.length - attachments.length;
		}
		return detached;
	}

	private async gcInternal(activeSessionIds: ReadonlySet<string>): Promise<GcResult> {
		let detached = 0;
		for (const manifest of this.store.list()) {
			const resident = this.resident.get(manifest.boxId);
			if (resident && resident.leases > 0) continue;
			const attachments = manifest.attachments.filter((attachment) => activeSessionIds.has(attachment.sessionId));
			if (attachments.length !== manifest.attachments.length) {
				for (const attachment of manifest.attachments) {
					if (!attachments.some((kept) => kept.sessionId === attachment.sessionId)) {
						this.unindexSession(attachment.sessionId, manifest.boxId);
					}
				}
				this.store.write({ ...manifest, attachments });
				detached += manifest.attachments.length - attachments.length;
			}
		}

		let trashed = 0;
		if (this.config.retentionMs > 0) {
			const cutoff = Date.now() - this.config.retentionMs;
			for (const manifest of this.store.list()) {
				if (manifest.attachments.length > 0) continue;
				const resident = this.resident.get(manifest.boxId);
				if (resident && (resident.leases > 0 || resident.stopping)) continue;
				const lastUsed = Date.parse(manifest.lastUsedAt);
				if (!Number.isFinite(lastUsed) || lastUsed > cutoff) continue;
				try {
					if (resident) await this.stopInternal(manifest.boxId);
					await this.destroyInternal(manifest.boxId);
					trashed += 1;
				} catch (error) {
					console.warn(`relay box: could not collect ${manifest.boxId}: ${toBoxError(error).message}`);
				}
			}
		}
		const removed = this.store.removeTrash(TRASH_TTL_MS);
		return { removed, trashed, detached };
	}

	private async reconcileInternal(): Promise<void> {
		for (const manifest of this.store.list()) {
			cleanupTempWorkspaces(this.store.dir(manifest.boxId));
		}
		try {
			const boxes = await this.runtime.list(this.labelsForList());
			for (const box of boxes) {
				if (box.status === "stopped" || box.status === "absent" || box.status === "crashed") continue;
				try {
					await this.runtime.stop(box.name);
				} catch (error) {
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
		for (const manifest of this.store.list()) {
			if (manifest.state === "error") continue;
			const rest = { ...manifest, state: "stopped" as const };
			delete rest.pausedAt;
			this.store.write(rest);
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
				if (manifest) this.store.write({ ...manifest, state: "stopped", lastUsedAt: new Date().toISOString() });
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
			if (!manifest) {
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
		for (const attachment of manifest.attachments) {
			let ids = this.sessionIndex.get(attachment.sessionId);
			if (!ids) {
				ids = new Set();
				this.sessionIndex.set(attachment.sessionId, ids);
			}
			ids.add(manifest.boxId);
		}
	}

	private unindexSession(sessionId: string, boxId: string): void {
		const ids = this.sessionIndex.get(sessionId);
		if (!ids) return;
		ids.delete(boxId);
		if (ids.size === 0) this.sessionIndex.delete(sessionId);
	}

	private async attachInternal(manifest: BoxManifest, sessionId: string): Promise<void> {
		if (manifest.attachments.some((attachment) => attachment.sessionId === sessionId)) return;
		const next: BoxManifest = {
			...manifest,
			attachments: [...manifest.attachments, { sessionId, attachedAt: new Date().toISOString() }],
		};
		this.store.write(next);
		this.indexManifest(next);
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

	private withState(manifest: BoxManifest, state: BoxState, error?: string): BoxManifest {
		const next: BoxManifest = {
			...manifest,
			state,
			lastUsedAt: new Date().toISOString(),
		};
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
