import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { BoxManagerImpl } from "../manager.ts";
import { boxIdFor, manifestPath, trashDir } from "../paths.ts";
import type { BoxSpec, BoxManagerConfig } from "../types.ts";
import { FakeRuntime } from "./fake-runtime.ts";

const SETTINGS = {
	image: "fake:latest",
	cpus: 1,
	memoryMiB: 512,
	rootDiskMiB: 1024,
	setup: "echo setup-ok",
	env: {},
	exclude: [],
};

async function fixture(): Promise<{
	root: string;
	project: string;
	config: BoxManagerConfig;
	runtime: FakeRuntime;
	manager: BoxManagerImpl;
}> {
	const root = await mkdtemp(join(tmpdir(), "relay-box-manager-"));
	const project = join(root, "project");
	await mkdir(project, { recursive: true });
	await writeFile(join(project, "README.md"), "hello\n");
	const config: BoxManagerConfig = {
		enabled: true,
		dataDir: join(root, "boxes"),
		cacheDir: join(root, "cache"),
		maxRunning: 1,
		idleMs: 60_000,
		acquireTimeoutMs: 5_000,
		setupTimeoutMs: 10_000,
		defaults: SETTINGS,
	};
	const runtime = new FakeRuntime();
	const manager = new BoxManagerImpl(config, runtime);
	return { root, project, config, runtime, manager };
}

function spec(project: string, sessionId: string): BoxSpec {
	return { sessionId, ownerId: "user-1", projectCwd: project, settings: SETTINGS };
}

describe("BoxManager", () => {
	it("provisions a workspace, runs setup once, and resumes after stop", async () => {
		const { project, runtime, manager } = await fixture();
		const lease = await Effect.runPromise(manager.acquire(spec(project, "session-1")));

		expect(existsSync(join(lease.workspace, "README.md"))).toBe(true);
		expect(await readFile(join(lease.workspace, "setup-ok.txt"), "utf8")).toBe("ok\n");
		expect(runtime.execs.some((exec) => exec.command.includes("setup-ok"))).toBe(true);

		await Effect.runPromise(lease.release());
		await Effect.runPromise(manager.stop("session-1"));
		expect(await runtime.status(runtime.boxes.keys().next().value ?? "")).toBe("stopped");

		const resumed = await Effect.runPromise(manager.acquire(spec(project, "session-1")));
		expect(resumed.status.state).toBe("running");
		await Effect.runPromise(resumed.release());
		await Effect.runPromise(manager.shutdown());
	});

	it("evicts the least-recently-used idle box when the running cap is reached", async () => {
		const { project, runtime, manager } = await fixture();
		const first = await Effect.runPromise(manager.acquire(spec(project, "session-a")));
		await Effect.runPromise(first.release());

		const second = await Effect.runPromise(manager.acquire(spec(project, "session-b")));
		const values = [...runtime.boxes.values()];
		expect(values.filter((box) => box.status === "running")).toHaveLength(1);
		const firstBox = values.find((box) => box.workspace.includes(boxIdFor("session-a")));
		expect(firstBox?.status).toBe("stopped");

		await Effect.runPromise(second.release());
		await Effect.runPromise(manager.shutdown());
	});

	it("marks a failed setup as an error and keeps the workspace for inspection", async () => {
		const { root, project, manager } = await fixture();
		const failedSettings = { ...SETTINGS, setup: "fail setup" };
		const failedSpec: BoxSpec = {
			sessionId: "session-fail",
			ownerId: "user-1",
			projectCwd: project,
			settings: failedSettings,
		};

		await expect(Effect.runPromise(manager.acquire(failedSpec))).rejects.toThrow();
		const boxId = boxIdFor("session-fail");
		expect(existsSync(join(root, "boxes", boxId, "workspace"))).toBe(true);
		expect(existsSync(manifestPath(join(root, "boxes"), boxId))).toBe(true);
		await Effect.runPromise(manager.shutdown());
	});

	it("trashes a destroyed box and removes trash on gc", async () => {
		const { root, project, manager } = await fixture();
		const lease = await Effect.runPromise(manager.acquire(spec(project, "session-gc")));
		await Effect.runPromise(lease.release());
		await Effect.runPromise(manager.destroy("session-gc"));
		const entries = readdirSync(trashDir(join(root, "boxes")));
		expect(entries.some((entry) => entry.startsWith(boxIdFor("session-gc")))).toBe(true);
		await Effect.runPromise(manager.shutdown());
	});
});
