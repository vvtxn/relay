import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { BoxManagerImpl } from "../manager.ts";
import type { BoxManagerConfig, BoxSpec } from "../types.ts";

const enabled = process.env.RELAY_BOX_TEST === "1";
const settings = {
	image: process.env.RELAY_BOX_TEST_IMAGE ?? "alpine",
	cpus: 1,
	memoryMiB: 512,
	rootDiskMiB: 1024,
	setup: "echo setup-ok > /workspace/setup.txt && cat /workspace/README.md",
	env: {},
	exclude: [],
};

async function fixture(): Promise<{ project: string; manager: BoxManagerImpl; spec: BoxSpec }> {
	const root = await mkdtemp(join(tmpdir(), "relay-box-integration-"));
	const project = join(root, "project");
	await mkdir(project, { recursive: true });
	await writeFile(join(project, "README.md"), "hello from the host\n");
	const config: BoxManagerConfig = {
		enabled: true,
		dataDir: join(root, "boxes"),
		cacheDir: join(root, "cache"),
		maxRunning: 1,
		idleMs: 60_000,
		acquireTimeoutMs: 60_000,
		setupTimeoutMs: 120_000,
		defaults: settings,
	};
	return {
		project,
		manager: new BoxManagerImpl(config),
		spec: { sessionId: "integration-session", ownerId: "integration-user", projectCwd: project, settings },
	};
}

describe.skipIf(!enabled)("Microsandbox integration", () => {
	it("creates a box, runs setup, persists across stop, and exposes files on the host", async () => {
		const { manager, spec } = await fixture();
		const lease = await Effect.runPromise(manager.acquire(spec));
		const first = await Effect.runPromise(lease.exec("cat /workspace/setup.txt && uname -s"));
		expect(first.code).toBe(0);
		expect(first.stdout).toContain("setup-ok");
		expect(first.stdout).toContain("Linux");
		expect(await readFile(join(lease.workspace, "setup.txt"), "utf8")).toBe("setup-ok\n");

		const timedOut = await Effect.runPromise(lease.exec("sleep 10", { timeoutMs: 300 }));
		expect(timedOut.code).toBe(124);

		await Effect.runPromise(lease.release());

		await Effect.runPromise(manager.reconcile());
		const stopped = await Effect.runPromise(manager.status(spec.sessionId));
		expect(stopped?.state).toBe("stopped");

		const resumed = await Effect.runPromise(manager.acquire(spec));
		const second = await Effect.runPromise(resumed.exec("cat /workspace/setup.txt"));
		expect(second.stdout).toBe("setup-ok\n");
		await Effect.runPromise(resumed.release());
		await Effect.runPromise(manager.destroy(spec.sessionId));
		await Effect.runPromise(manager.shutdown());
	}, 180_000);
});
