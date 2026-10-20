import type { Effect } from "effect";
import type { BoxError } from "./errors.ts";

export type BoxState = "provisioning" | "running" | "stopped" | "error";

/** Resolved configuration for one box. */
export interface BoxSettings {
	image: string;
	cpus: number;
	memoryMiB: number;
	rootDiskMiB: number;
	setup?: string;
	resume?: string;
	env: Record<string, string>;
	exclude: string[];
}

/** The subset a project may configure in `.relay/box.json`. */
export interface ProjectBoxConfig {
	version?: number;
	image?: string;
	cpus?: number;
	memoryMiB?: number;
	rootDiskMiB?: number;
	setup?: string;
	resume?: string;
	env?: Record<string, string>;
	exclude?: string[];
}

export interface BoxSpec {
	sessionId: string;
	ownerId: string;
	projectCwd: string;
	settings: BoxSettings;
	signal?: AbortSignal;
}

export interface BoxStatus {
	boxId: string;
	sessionId: string;
	projectCwd: string;
	/** Host path of the workspace mounted at /workspace. Local-only in v0. */
	workspace: string;
	state: BoxState;
	createdAt: string;
	lastUsedAt: string;
	error?: string;
}

export interface ExecOptions {
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	truncated: boolean;
}

export interface BoxLease {
	readonly status: BoxStatus;
	readonly workspace: string;
	exec(command: string, options?: ExecOptions): Effect.Effect<ExecResult, BoxError>;
	release(): Effect.Effect<void>;
}

export interface GcResult {
	removed: number;
	trashed: number;
}

export interface BoxManager {
	readonly enabled: boolean;
	acquire(spec: BoxSpec): Effect.Effect<BoxLease, BoxError>;
	status(sessionId: string): Effect.Effect<BoxStatus | null, BoxError>;
	stop(sessionId: string): Effect.Effect<void, BoxError>;
	destroy(sessionId: string): Effect.Effect<void, BoxError>;
	gc(activeSessionIds: ReadonlySet<string>): Effect.Effect<GcResult, BoxError>;
	reconcile(): Effect.Effect<void, BoxError>;
	shutdown(): Effect.Effect<void, BoxError>;
}

export type RuntimeStatus =
	| "absent"
	| "created"
	| "starting"
	| "running"
	| "draining"
	| "paused"
	| "stopped"
	| "crashed";

export interface RuntimeBoxInfo {
	name: string;
	status: RuntimeStatus;
	boxId?: string;
}

export interface RuntimeCreateInput {
	name: string;
	settings: BoxSettings;
	workspace: string;
	cacheDir: string;
	labels: Record<string, string>;
}

export interface RuntimeExecOptions {
	cwd: string;
	env: Record<string, string>;
	timeoutMs: number;
	signal?: AbortSignal;
}

/** Runtime seam: the manager owns workspaces and manifests; this owns VMs. */
export interface BoxRuntime {
	readonly kind: string;
	create(input: RuntimeCreateInput): Promise<void>;
	start(name: string): Promise<void>;
	stop(name: string): Promise<void>;
	destroy(name: string): Promise<void>;
	status(name: string): Promise<RuntimeStatus>;
	exec(name: string, command: string, options: RuntimeExecOptions): Promise<ExecResult>;
	list(labels: Record<string, string>): Promise<RuntimeBoxInfo[]>;
}

/** Settings used by the server configuration layer before project overrides. */
export interface BoxManagerConfig {
	enabled: boolean;
	dataDir: string;
	cacheDir: string;
	maxRunning: number;
	idleMs: number;
	acquireTimeoutMs: number;
	setupTimeoutMs: number;
	defaults: BoxSettings;
}
