import { mkdirSync } from "node:fs";
import type { Sandbox } from "microsandbox";
import { boxBaseEnv } from "./env.ts";
import { BoxError, toBoxError } from "./errors.ts";
import type {
	BoxRuntime,
	ExecResult,
	RuntimeBoxInfo,
	RuntimeCreateInput,
	RuntimeExecOptions,
	RuntimeResizeInput,
	RuntimeResizeResult,
	RuntimeStatus,
} from "./types.ts";

type MicrosandboxModule = typeof import("microsandbox");

const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const GIT_ASKPASS_PATH = "/usr/local/bin/relay-git-askpass";
const GIT_ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' "x-access-token" ;;
  *Password*) printf '%s\\n' "\${GITHUB_TOKEN:-}" ;;
  *) printf '\\n' ;;
esac
`;

function normalizeStatus(status: string): RuntimeStatus {
	switch (status) {
		case "absent":
		case "created":
		case "starting":
		case "running":
		case "draining":
		case "paused":
		case "stopped":
		case "crashed":
			return status;
		default:
			return "created";
	}
}

function decode(chunks: Uint8Array[]): string {
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

/**
 * Local Microsandbox runtime. This is the only module that imports the native
 * package, and the import is lazy so Relay still starts on unsupported hosts.
 */
export class MicrosandboxRuntime implements BoxRuntime {
	readonly kind = "microsandbox";
	private readonly cacheDir: string;
	private modulePromise: Promise<MicrosandboxModule> | null = null;
	private readonly handles = new Map<string, Sandbox>();

	constructor(cacheDir: string) {
		this.cacheDir = cacheDir;
	}

	private async module(): Promise<MicrosandboxModule> {
		if (!this.modulePromise) {
			this.modulePromise = import("microsandbox").catch((error: unknown) => {
				this.modulePromise = null;
				throw new BoxError({
					message:
						"Microsandbox is unavailable on this host. Install the platform package and ensure KVM/hypervisor access is available.",
					cause: error,
				});
			});
		}
		return await this.modulePromise;
	}

	async create(input: RuntimeCreateInput): Promise<void> {
		const ms = await this.module();
		mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
		let builder = ms.Sandbox.builder(input.name)
			.image(input.settings.image)
			.cpus(input.settings.cpus)
			// Hotplug ceilings let the manager resize live without recreating the VM.
			.maxCpus(Math.max(input.maxCpus, input.settings.cpus))
			.memory(input.settings.memoryMiB)
			.maxMemory(Math.max(input.maxMemoryMiB, input.settings.memoryMiB))
			.rootDisk(input.settings.rootDiskMiB)
			.workdir("/workspace")
			.detached(true)
			.cmd(["sleep", "infinity"])
			.volume("/workspace", (mount) => mount.bind(input.workspace))
			.volume("/relay-cache", (mount) => mount.bind(this.cacheDir))
			.envs(boxBaseEnv(input.settings))
			.labels(input.labels)
			.patch((patch) => patch.text(GIT_ASKPASS_PATH, GIT_ASKPASS_SCRIPT, { mode: 0o755, replace: true }));
		for (const secret of input.secrets) {
			for (const host of secret.allowedHosts) {
				builder = builder.secretEnv(secret.envVar, secret.value, host);
			}
		}
		try {
			const sandbox = await builder.create();
			await sandbox.detach();
			this.handles.delete(input.name);
		} catch (error) {
			throw toBoxError(error, `Could not create sandbox ${input.name}`);
		}
	}

	async start(name: string): Promise<void> {
		const ms = await this.module();
		try {
			const handle = await ms.Sandbox.get(name);
			const sandbox = await handle.connectOrStart({ detached: true });
			this.handles.set(name, sandbox);
		} catch (error) {
			throw toBoxError(error, `Could not start sandbox ${name}`);
		}
	}

	async pause(name: string): Promise<void> {
		const ms = await this.module();
		try {
			const handle = await ms.Sandbox.get(name);
			await handle.pause();
			this.handles.delete(name);
		} catch (error) {
			if (error instanceof ms.SandboxNotFoundError) return;
			throw toBoxError(error, `Could not pause sandbox ${name}`);
		}
	}

	async resume(name: string): Promise<void> {
		const ms = await this.module();
		try {
			const handle = await ms.Sandbox.get(name);
			await handle.resume();
			const sandbox = await handle.connectOrStart({ detached: true });
			this.handles.set(name, sandbox);
		} catch (error) {
			throw toBoxError(error, `Could not resume sandbox ${name}`);
		}
	}

	async modify(name: string, input: RuntimeResizeInput): Promise<RuntimeResizeResult> {
		const ms = await this.module();
		try {
			const handle = await ms.Sandbox.get(name);
			const plan = await handle.modify({
				cpus: input.cpus,
				memory: input.memoryMiB,
				rootDiskSize: input.rootDiskMiB,
				policy: "no_restart",
			});
			return {
				applied: plan.applied,
				status: plan.status,
				resizeStatus: plan.resizeStatus.map((status) => ({
					resource: status.resource,
					requested: status.requested,
					actual: status.actual,
					state: status.state,
				})),
			};
		} catch (error) {
			throw toBoxError(error, `Could not resize sandbox ${name}`);
		}
	}

	async stop(name: string): Promise<void> {
		const ms = await this.module();
		try {
			const cached = this.handles.get(name);
			if (cached) {
				await cached.stopWithTimeout(10_000);
				return;
			}
			const handle = await ms.Sandbox.get(name);
			await handle.stopWithTimeout(10_000);
		} catch (error) {
			if (error instanceof ms.SandboxNotFoundError) return;
			throw toBoxError(error, `Could not stop sandbox ${name}`);
		} finally {
			this.handles.delete(name);
		}
	}

	async destroy(name: string): Promise<void> {
		const ms = await this.module();
		try {
			const handle = await ms.Sandbox.get(name);
			await handle.destroy({ force: true, timeoutMs: 10_000 });
		} catch (error) {
			if (error instanceof ms.SandboxNotFoundError) return;
			throw toBoxError(error, `Could not remove sandbox ${name}`);
		} finally {
			this.handles.delete(name);
		}
	}

	async status(name: string): Promise<RuntimeStatus> {
		const ms = await this.module();
		try {
			const handle = await ms.Sandbox.get(name);
			return normalizeStatus(handle.status);
		} catch (error) {
			if (error instanceof ms.SandboxNotFoundError) return "absent";
			throw toBoxError(error, `Could not inspect sandbox ${name}`);
		}
	}

	async exec(name: string, command: string, options: RuntimeExecOptions): Promise<ExecResult> {
		const ms = await this.module();
		const started = Date.now();
		let sandbox: Sandbox;
		try {
			sandbox = await this.connected(name);
		} catch (error) {
			throw toBoxError(error, `Sandbox ${name} is not running`);
		}

		const stdout: Uint8Array[] = [];
		const stderr: Uint8Array[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let code = 0;
		let truncated = false;
		let timedOut = false;
		let aborted = false;
		let sawStart = false;

		try {
			const handle = await sandbox.execStreamWith("sh", (builder) =>
				builder
					.arg("-lc")
					.arg(command)
					.cwd(options.cwd)
					.envs(options.env)
					.timeout(options.timeoutMs)
					.stdinNull(),
			);

			const onAbort = (): void => {
				aborted = true;
				void handle.kill().catch(() => {});
			};
			options.signal?.addEventListener("abort", onAbort, { once: true });
			if (options.signal?.aborted) onAbort();

			try {
				for await (const event of handle) {
					if (!event) break;
					if (event.kind === "started") {
						sawStart = true;
					} else if (event.kind === "stdout") {
						stdoutBytes += event.data.byteLength;
						if (stdoutBytes <= MAX_STREAM_BYTES) stdout.push(event.data);
						else truncated = true;
					} else if (event.kind === "stderr") {
						stderrBytes += event.data.byteLength;
						if (stderrBytes <= MAX_STREAM_BYTES) stderr.push(event.data);
						else truncated = true;
					} else if (event.kind === "exited") {
						code = event.code;
					}
					if (truncated) {
						await handle.kill().catch(() => {});
						break;
					}
				}
			} finally {
				options.signal?.removeEventListener("abort", onAbort);
			}

			if (aborted) code = 130;
			if (truncated) code = 137;
			if (code < 0 && !aborted) {
				timedOut = true;
				code = 124;
			}
			if (!sawStart && !truncated && !aborted) {
				throw new BoxError({ message: `Command did not start in sandbox ${name}` });
			}
		} catch (error) {
			if (error instanceof ms.ExecTimeoutError) {
				timedOut = true;
				code = 124;
			} else {
				throw toBoxError(error, `Command failed in sandbox ${name}`);
			}
		}

		return {
			code,
			stdout: decode(stdout),
			stderr: timedOut
				? `${decode(stderr)}\nCommand timed out after ${options.timeoutMs}ms`.trim()
				: decode(stderr),
			durationMs: Date.now() - started,
			truncated: truncated || timedOut,
		};
	}

	async listImages(): Promise<string[]> {
		const ms = await this.module();
		const images = await ms.Image.list();
		return images.map((image) => image.reference);
	}

	async list(labels: Record<string, string>): Promise<RuntimeBoxInfo[]> {
		const ms = await this.module();
		const results: RuntimeBoxInfo[] = [];
		let cursor: string | undefined;
		try {
			do {
				const page = await ms.Sandbox.listWith((builder) => {
					let configured = builder.limit(100);
					for (const [key, value] of Object.entries(labels)) configured = configured.label(key, value);
					if (cursor) configured = configured.cursor(cursor);
					return configured;
				});
				for (const handle of page.sandboxes) {
					results.push({
						name: handle.name,
						status: normalizeStatus(handle.status),
					});
				}
				cursor = page.nextCursor;
			} while (cursor);
			return results;
		} catch (error) {
			throw toBoxError(error, "Could not list sandboxes");
		}
	}

	private async connected(name: string): Promise<Sandbox> {
		const existing = this.handles.get(name);
		if (existing) return existing;
		const ms = await this.module();
		const handle = await ms.Sandbox.get(name);
		const sandbox = await handle.connectOrStart({ detached: true });
		this.handles.set(name, sandbox);
		return sandbox;
	}
}
