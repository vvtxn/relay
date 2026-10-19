import { existsSync, mkdirSync, statSync } from "node:fs";
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
	boxIdFor,
	dataDirHash,
	ensureBoxDirs,
	sandboxNameFor,
	workspacePath,
} from "./paths.ts";
import { cleanupTempWorkspaces, prepareWorkspace } from "./workspace.ts";
import type {
	BoxLease,
	BoxManager,
	BoxManagerConfig,
	BoxSpec,
	BoxState,
	BoxStatus,
	ExecOptions,
	ExecResult,
	GcResult,
	BoxRuntime,
	RuntimeStatus,
} from "./types.ts";

const SWEEP_INTERVAL_MS = 30_000;
const TRASH_TTL_MS = 7 * 24 * 60 * 60_000;
const MICROSANDBOX_VERSION = "0.7.8";

interface RunningEntry {
	leases: number;
	lastUsedAt: number;
	stopping: boolean;
}

type SlotOutcome = { kind: "reserved" } | { kind: "evict"; boxId: string } | { kind: "wait" };

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
	readonly status: BoxStatus;
	readonly workspace: string;

	constructor(manager: BoxManagerImpl, status: BoxStatus, workspace: string) {
		this.manager = manager;
		this.status = status;
		this.workspace = workspace;
	}

	exec(command: string, options?: ExecOptions): Effect.Effect<ExecResult, BoxError> {
		return this.manager.exec(this.status.sessionId, command, options);
	}

	release(): Effect.Effect<void> {
		return Effect.promise(async () => {
			if (this.released) return;
			this.released = true;
			await this.manager.release(this.status.sessionId);
		});
	}
}

/** Boxes are disabled: runs keep using the host workspace. */
export class DisabledBoxManager implements BoxManager {
	readonly enabled = false;

	acquire(): Effect.Effect<BoxLease, BoxError> {
		return Effect.fail(new BoxError({ message: "Boxes are disabled (set RELAY_BOX=1 to enable)" }));
	}

	status(): Effect.Effect<BoxStatus | null, BoxError> {
		return Effect.succeed(null);
	}

	stop(): Effect.Effect<void, BoxError> {
		return Effect.void;
	}

	destroy(): Effect.Effect<void, BoxError> {
		return Effect.void;
	}

	gc(): Effect.Effect<GcResult, BoxError> {
		return Effect.succeed({ removed: 0, trashed: 0 });
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
	private readonly running = new Map<string, RunningEntry>();
	private readonly boxesLock = new Map<string, Mutex>();
	private readonly schedulerLock = new Mutex();
	private readonly waiters: Array<() => void> = [];
	private sweepTimer: NodeJS.Timeout | null = null;
	private sweeping = false;
	private shuttingDown = false;

	constructor(config: BoxManagerConfig, runtime?: BoxRuntime) {
		this.config = config;
		mkdirSync(config.cacheDir, { recursive: true, mode: 0o700 });
		this.store = new FileBoxStore(config.dataDir);
		this.releaseLock = acquireDataDirLock(config.dataDir);
		this.runtime = runtime ?? new MicrosandboxRuntime(config.cacheDir);
		this.sweepTimer = setInterval(() => {
			void this.sweep();
		}, SWEEP_INTERVAL_MS);
		this.sweepTimer.unref();
	}

	acquire(spec: BoxSpec): Effect.Effect<BoxLease, BoxError> {
		return Effect.tryPromise({
			try: () => this.acquireInternal(spec),
			catch: (error) => toBoxError(error, "Could not acquire box"),
		});
	}

	status(sessionId: string): Effect.Effect<BoxStatus | null, BoxError> {
		return Effect.tryPromise({
			try: () => this.statusInternal(sessionId),
			catch: (error) => toBoxError(error, "Could not inspect box"),
		});
	}

	stop(sessionId: string): Effect.Effect<void, BoxError> {
		return Effect.tryPromise({
			try: () => this.stopSession(sessionId),
			catch: (error) => toBoxError(error, "Could not stop box"),
		});
	}

	destroy(sessionId: string): Effect.Effect<void, BoxError> {
		return Effect.tryPromise({
			try: () => this.destroyInternal(sessionId),
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

	exec(sessionId: string, command: string, options: ExecOptions = {}): Effect.Effect<ExecResult, BoxError> {
		return Effect.tryPromise({
			try: () => this.execInternal(sessionId, command, options),
			catch: (error) => toBoxError(error, "Command failed"),
		});
	}

	async release(sessionId: string): Promise<void> {
		const boxId = boxIdFor(sessionId);
		await this.schedulerLock.run(() => {
			const entry = this.running.get(boxId);
			if (!entry) return;
			entry.leases = Math.max(0, entry.leases - 1);
			entry.lastUsedAt = Date.now();
			this.wakeWaiters();
		});
	}

	private async acquireInternal(spec: BoxSpec): Promise<BoxLease> {
		if (spec.signal?.aborted) throw new BoxError({ message: "Box acquisition was cancelled" });
		const boxId = boxIdFor(spec.sessionId);
		await this.reserveSlot(boxId, spec.signal);

		try {
			const manifest = await this.withBoxLock(boxId, () => this.ensureManifestAndStart(spec));
			return new Lease(this, this.statusFromManifest(manifest, "running"), manifest.workspacePath);
		} catch (error) {
			const entry = this.running.get(boxId);
			if ((entry?.leases ?? 0) <= 1) {
				const manifest = this.store.load(boxId);
				if (manifest) await this.runtime.stop(manifest.sandboxName).catch(() => {});
			}
			await this.releaseSlot(boxId);
			throw error;
		}
	}

	private async ensureManifestAndStart(spec: BoxSpec): Promise<BoxManifest> {
		const boxId = boxIdFor(spec.sessionId);
		const dir = boxDir(this.config.dataDir, boxId);
		const workspace = workspacePath(this.config.dataDir, boxId);
		cleanupTempWorkspaces(dir);

		let manifest = this.store.load(boxId);
		let created = false;

		if (manifest && manifest.ownerId !== spec.ownerId) {
			throw new BoxError({ message: "This box belongs to a different user" });
		}

		if (!manifest) {
			if (isPathInside(spec.projectCwd, this.config.dataDir)) {
				throw new BoxError({ message: "The project directory must not be inside the box data directory" });
			}
			ensureBoxDirs(this.config.dataDir, boxId);
			if (!existsSync(workspace)) {
				await prepareWorkspace(spec.projectCwd, dir, workspace, spec.settings.exclude);
			}
			const now = new Date().toISOString();
			const createdAt = existsSync(workspace) ? statSync(workspace).birthtime.toISOString() : now;
			manifest = {
				version: MANIFEST_VERSION,
				boxId,
				sessionId: spec.sessionId,
				ownerId: spec.ownerId,
				projectCwd: spec.projectCwd,
				workspacePath: workspace,
				sandboxName: sandboxNameFor(this.config.dataDir, boxId),
				runtime: { kind: this.runtime.kind, version: MICROSANDBOX_VERSION },
				settings: spec.settings,
				state: "provisioning",
				setupState: "pending",
				createdAt,
				lastUsedAt: now,
			};
			this.store.write(manifest);
			created = true;
			console.log(`relay box: created ${boxId} at ${workspace}`);
		}

		if (!existsSync(workspace)) {
			const failed = this.withState(manifest, "error", "Box workspace is missing");
			this.store.write(failed);
			throw new BoxError({ message: `Box workspace is missing: ${workspace}` });
		}

		const before = await this.runtime.status(manifest.sandboxName);
		const needsStart =
			before !== "running" && before !== "starting" && before !== "draining" && before !== "paused";

		if (before === "absent") {
			try {
				await this.runtime.create({
					name: manifest.sandboxName,
					settings: manifest.settings,
					workspace: manifest.workspacePath,
					cacheDir: this.config.cacheDir,
					labels: this.labels(boxId),
				});
			} catch (error) {
				// A concurrent create or a crash between inspect and create can leave a
				// sandbox behind. Adopt it if it exists; only otherwise mark the box bad.
				const current = await this.runtime.status(manifest.sandboxName).catch(() => "absent" as const);
				if (current !== "absent") {
					await this.runtime.start(manifest.sandboxName);
				} else {
					const failed = this.withState(manifest, "error", toBoxError(error).message);
					this.store.write(failed);
					throw error;
				}
			}
		} else if (needsStart || before === "paused") {
			try {
				await this.runtime.start(manifest.sandboxName);
			} catch (error) {
				// A crashed sandbox may be recovered by recreating it around the same workspace.
				if (before === "crashed") {
					await this.runtime.destroy(manifest.sandboxName).catch(() => {});
					await this.runtime.create({
						name: manifest.sandboxName,
						settings: manifest.settings,
						workspace: manifest.workspacePath,
						cacheDir: this.config.cacheDir,
						labels: this.labels(boxId),
					});
				} else {
					const failed = this.withState(manifest, "error", toBoxError(error).message);
					this.store.write(failed);
					throw error;
				}
			}
		}

		if (manifest.setupState !== "ok" && manifest.settings.setup) {
			const setupState = await this.runHook(
				manifest,
				"setup",
				manifest.settings.setup,
				this.config.setupTimeoutMs,
				true,
			);
			manifest = { ...manifest, setupState };
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

		if ((needsStart || created) && manifest.settings.resume) {
			await this.runHook(manifest, "resume", manifest.settings.resume, this.config.setupTimeoutMs, false);
		}

		const running = this.withState(manifest, "running");
		this.store.write(running);
		return running;
	}

	private async runHook(
		manifest: BoxManifest,
		name: "setup" | "resume",
		command: string,
		timeoutMs: number,
		fatal: boolean,
	): Promise<SetupState> {
		const result = await this.runtime.exec(manifest.sandboxName, command, {
			cwd: "/workspace",
			env: boxExecEnv(manifest.settings),
			timeoutMs,
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

	private async reserveSlot(boxId: string, signal?: AbortSignal): Promise<void> {
		const deadline = Date.now() + this.config.acquireTimeoutMs;
		for (;;) {
			if (signal?.aborted) throw new BoxError({ message: "Box acquisition was cancelled" });
			const outcome = await this.schedulerLock.run(() => this.tryReserve(boxId));
			if (outcome.kind === "reserved") return;
			if (outcome.kind === "evict") {
				await this.evict(outcome.boxId);
				continue;
			}
			const left = deadline - Date.now();
			if (left <= 0) throw new BoxError({ message: "Timed out waiting for a box slot" });
			await this.waitForSlot(left, signal);
		}
	}

	private tryReserve(boxId: string): SlotOutcome {
		const existing = this.running.get(boxId);
		if (existing) {
			if (existing.stopping) return { kind: "wait" };
			existing.leases += 1;
			existing.lastUsedAt = Date.now();
			return { kind: "reserved" };
		}
		if (this.running.size < this.config.maxRunning) {
			this.running.set(boxId, { leases: 1, lastUsedAt: Date.now(), stopping: false });
			return { kind: "reserved" };
		}
		let victim: string | null = null;
		let oldest = Number.POSITIVE_INFINITY;
		for (const [candidate, entry] of this.running) {
			if (entry.leases > 0 || entry.stopping) continue;
			if (entry.lastUsedAt < oldest) {
				oldest = entry.lastUsedAt;
				victim = candidate;
			}
		}
		if (!victim) return { kind: "wait" };
		const entry = this.running.get(victim);
		if (entry) entry.stopping = true;
		return { kind: "evict", boxId: victim };
	}

	private waitForSlot(timeoutMs: number, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (error?: BoxError): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				if (error) reject(error);
				else resolve();
			};
			const timer = setTimeout(
				() => finish(new BoxError({ message: "Timed out waiting for a box slot" })),
				timeoutMs,
			);
			const onAbort = (): void => finish(new BoxError({ message: "Box acquisition was cancelled" }));
			signal?.addEventListener("abort", onAbort, { once: true });
			this.waiters.push(() => finish());
		});
	}

	private wakeWaiters(): void {
		const waiters = this.waiters.splice(0);
		for (const wake of waiters) wake();
	}

	private async evict(boxId: string): Promise<void> {
		const manifest = this.store.load(boxId);
		try {
			if (manifest) await this.runtime.stop(manifest.sandboxName);
		} catch (error) {
			await this.schedulerLock.run(() => {
				const entry = this.running.get(boxId);
				if (entry) entry.stopping = false;
				this.wakeWaiters();
			});
			throw error;
		}
		await this.schedulerLock.run(() => {
			this.running.delete(boxId);
			this.wakeWaiters();
		});
		if (manifest) {
			const stopped = this.withState(manifest, "stopped");
			this.store.write(stopped);
		}
	}

	private async releaseSlot(boxId: string): Promise<void> {
		await this.schedulerLock.run(() => {
			const entry = this.running.get(boxId);
			if (!entry) return;
			entry.leases = Math.max(0, entry.leases - 1);
			if (entry.leases === 0) {
				this.running.delete(boxId);
				this.wakeWaiters();
			}
		});
	}

	private async statusInternal(sessionId: string): Promise<BoxStatus | null> {
		const boxId = boxIdFor(sessionId);
		const manifest = this.store.load(boxId);
		if (!manifest) return null;
		let runtimeStatus: RuntimeStatus = "absent";
		try {
			runtimeStatus = await this.runtime.status(manifest.sandboxName);
		} catch {
			runtimeStatus = manifest.state === "error" ? "crashed" : "absent";
		}
		return this.statusFromManifest(manifest, this.mapRuntimeState(manifest, runtimeStatus));
	}

	private mapRuntimeState(manifest: BoxManifest, status: RuntimeStatus): BoxState {
		if (manifest.setupState === "failed") return "error";
		switch (status) {
			case "running":
			case "starting":
			case "draining":
			case "paused":
				return "running";
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
			sessionId: manifest.sessionId,
			projectCwd: manifest.projectCwd,
			workspace: manifest.workspacePath,
			state,
			createdAt: manifest.createdAt,
			lastUsedAt: manifest.lastUsedAt,
			...(manifest.error ? { error: manifest.error } : {}),
		};
	}

	private async execInternal(sessionId: string, command: string, options: ExecOptions): Promise<ExecResult> {
		const manifest = this.store.load(boxIdFor(sessionId));
		if (!manifest) throw new BoxError({ message: `No box found for session ${sessionId}` });
		return await this.runtime.exec(manifest.sandboxName, command, {
			cwd: options.cwd ?? "/workspace",
			env: boxExecEnv(manifest.settings, options.env),
			timeoutMs: options.timeoutMs ?? 30_000,
			...(options.signal ? { signal: options.signal } : {}),
		});
	}

	private async stopSession(sessionId: string): Promise<void> {
		const boxId = boxIdFor(sessionId);
		const manifest = this.store.load(boxId);
		if (!manifest) return;
		await this.beginStop(boxId);
		try {
			await this.runtime.stop(manifest.sandboxName);
		} catch (error) {
			await this.cancelStop(boxId);
			throw error;
		}
		await this.endStop(boxId);
		this.store.write(this.withState(manifest, "stopped"));
	}

	private async destroyInternal(sessionId: string): Promise<void> {
		const boxId = boxIdFor(sessionId);
		const manifest = this.store.load(boxId);
		if (!manifest) return;
		await this.beginStop(boxId);
		try {
			await this.runtime.destroy(manifest.sandboxName);
		} catch (error) {
			await this.cancelStop(boxId);
			throw error;
		}
		await this.endStop(boxId);
		this.store.trash(manifest);
	}

	private async beginStop(boxId: string): Promise<void> {
		await this.schedulerLock.run(() => {
			const entry = this.running.get(boxId);
			if (!entry) return;
			if (entry.leases > 0) {
				throw new BoxError({ message: "Cannot stop or remove a box while a run is using it" });
			}
			entry.stopping = true;
		});
	}

	private async cancelStop(boxId: string): Promise<void> {
		await this.schedulerLock.run(() => {
			const entry = this.running.get(boxId);
			if (entry) entry.stopping = false;
			this.wakeWaiters();
		});
	}

	private async endStop(boxId: string): Promise<void> {
		await this.schedulerLock.run(() => {
			this.running.delete(boxId);
			this.wakeWaiters();
		});
	}

	private async gcInternal(activeSessionIds: ReadonlySet<string>): Promise<GcResult> {
		let trashed = 0;
		for (const manifest of this.store.list()) {
			if (activeSessionIds.has(manifest.sessionId)) continue;
			const entry = this.running.get(manifest.boxId);
			if (entry && entry.leases > 0) continue;
			try {
				await this.runtime.destroy(manifest.sandboxName);
				await this.schedulerLock.run(() => {
					this.running.delete(manifest.boxId);
					this.wakeWaiters();
				});
				this.store.trash(manifest);
				trashed += 1;
			} catch (error) {
				console.warn(`relay box: could not collect ${manifest.boxId}: ${toBoxError(error).message}`);
			}
		}
		const removed = this.store.removeTrash(TRASH_TTL_MS);
		return { removed, trashed };
	}

	private async reconcileInternal(): Promise<void> {
		// The data-dir lock guarantees no other manager is using these sandboxes.
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
			this.running.clear();
			this.wakeWaiters();
		});
		for (const manifest of this.store.list()) {
			if (manifest.state === "running" || manifest.state === "provisioning") {
				this.store.write(this.withState(manifest, "stopped"));
			}
		}
	}

	private async shutdownInternal(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		if (this.sweepTimer) clearInterval(this.sweepTimer);
		this.sweepTimer = null;
		const entries = [...this.running.keys()];
		for (const boxId of entries) {
			const manifest = this.store.load(boxId);
			if (!manifest) continue;
			try {
				await this.runtime.stop(manifest.sandboxName);
				this.store.write(this.withState(manifest, "stopped"));
			} catch (error) {
				console.warn(`relay box: could not stop ${boxId}: ${toBoxError(error).message}`);
			}
		}
		await this.schedulerLock.run(() => {
			this.running.clear();
			this.wakeWaiters();
		});
		this.releaseLock();
	}

	private async sweep(): Promise<void> {
		if (this.sweeping || this.shuttingDown) return;
		this.sweeping = true;
		try {
			const cutoff = Date.now() - this.config.idleMs;
			const idle: string[] = [];
			await this.schedulerLock.run(() => {
				for (const [boxId, entry] of this.running) {
					if (entry.leases > 0 || entry.stopping || entry.lastUsedAt > cutoff) continue;
					entry.stopping = true;
					idle.push(boxId);
				}
			});
			for (const boxId of idle) {
				const manifest = this.store.load(boxId);
				let stopped = true;
				try {
					if (manifest) await this.runtime.stop(manifest.sandboxName);
					if (manifest) this.store.write(this.withState(manifest, "stopped"));
				} catch (error) {
					stopped = false;
					console.warn(`relay box: idle stop failed for ${boxId}: ${toBoxError(error).message}`);
				} finally {
					await this.schedulerLock.run(() => {
						if (!stopped) {
							const entry = this.running.get(boxId);
							if (entry) entry.stopping = false;
						} else {
							this.running.delete(boxId);
						}
						this.wakeWaiters();
					});
				}
			}
		} finally {
			this.sweeping = false;
		}
	}

	private withBoxLock<T>(boxId: string, fn: () => Promise<T>): Promise<T> {
		let mutex = this.boxesLock.get(boxId);
		if (!mutex) {
			mutex = new Mutex();
			this.boxesLock.set(boxId, mutex);
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
