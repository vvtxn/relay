import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	BoxRuntime,
	ExecResult,
	RuntimeBoxInfo,
	RuntimeCreateInput,
	RuntimeExecOptions,
	RuntimeStatus,
} from "../types.ts";

interface FakeBox {
	name: string;
	status: RuntimeStatus;
	workspace: string;
	settings: RuntimeCreateInput["settings"];
}

export class FakeRuntime implements BoxRuntime {
	readonly kind = "fake";
	readonly boxes = new Map<string, FakeBox>();
	readonly execs: Array<{ name: string; command: string; options: RuntimeExecOptions }> = [];

	async create(input: RuntimeCreateInput): Promise<void> {
		if (this.boxes.has(input.name)) throw new Error(`sandbox ${input.name} already exists`);
		this.boxes.set(input.name, {
			name: input.name,
			status: "running",
			workspace: input.workspace,
			settings: input.settings,
		});
	}

	async start(name: string): Promise<void> {
		const box = this.require(name);
		box.status = "running";
	}

	async stop(name: string): Promise<void> {
		const box = this.boxes.get(name);
		if (box) box.status = "stopped";
	}

	async destroy(name: string): Promise<void> {
		this.boxes.delete(name);
	}

	async status(name: string): Promise<RuntimeStatus> {
		return this.boxes.get(name)?.status ?? "absent";
	}

	async exec(name: string, command: string, options: RuntimeExecOptions): Promise<ExecResult> {
		const box = this.require(name);
		if (box.status !== "running") throw new Error(`sandbox ${name} is not running`);
		this.execs.push({ name, command, options });
		const code = command.includes("fail") ? 1 : 0;
		if (code === 0 && command.includes("setup-ok")) {
			await writeFile(join(box.workspace, "setup-ok.txt"), "ok\n", "utf8");
		}
		return { code, stdout: code === 0 ? "ok\n" : "failed\n", stderr: "", durationMs: 1, truncated: false };
	}

	async list(): Promise<RuntimeBoxInfo[]> {
		return [...this.boxes.values()].map((box) => ({ name: box.name, status: box.status }));
	}

	private require(name: string): FakeBox {
		const box = this.boxes.get(name);
		if (!box) throw new Error(`sandbox ${name} not found`);
		return box;
	}
}
