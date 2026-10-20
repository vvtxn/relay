/**
 * Smoke-test the built single executable without touching the user's HOME.
 * Used by CI and available locally as `pnpm smoke:sea`.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const binary = join(root, "dist", "relay");
const timeoutMs = 20_000;

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close((error) => (error ? reject(error) : resolve(port)));
		});
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(url: string, child: ReturnType<typeof spawn>, stderr: () => string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`relay serve exited (${child.exitCode})\n${stderr()}`);
		try {
			const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) });
			if (response.ok) return;
		} catch {
			// Not up yet.
		}
		await delay(100);
	}
	throw new Error(`relay serve did not become healthy within ${timeoutMs}ms\n${stderr()}`);
}

const home = await mkdtemp(join(tmpdir(), "relay-sea-smoke-"));
const port = await freePort();
const url = `http://127.0.0.1:${port}`;
let stderr = "";

const child = spawn(binary, ["serve"], {
	env: {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		RELAY_WORKSPACE: home,
		RELAY_PORT: String(port),
	},
	stdio: ["ignore", "ignore", "pipe"],
});
child.stderr.on("data", (chunk: Buffer) => {
	stderr += chunk.toString();
});

try {
	await waitForHealth(url, child, () => stderr);

	const me = await fetch(`${url}/api/me`);
	if (!me.ok) throw new Error(`/api/me returned ${me.status}`);
	const user = (await me.json()) as { provider?: string };
	if (user.provider !== "local") throw new Error(`expected local auth, got ${JSON.stringify(user)}`);

	const web = await fetch(`${url}/`, { headers: { accept: "text/html" } });
	if (!web.ok || !(await web.text()).includes('<div id="root">')) {
		throw new Error(`web client did not serve (${web.status})`);
	}

	const version = spawn(binary, ["version"], { env: { ...process.env, HOME: home } });
	let versionOut = "";
	version.stdout.on("data", (chunk: Buffer) => {
		versionOut += chunk.toString();
	});
	const versionCode = await new Promise<number | null>((resolve) => version.once("exit", resolve));
	if (versionCode !== 0 || versionOut.trim().length === 0) {
		throw new Error(`relay version failed (${versionCode}): ${versionOut}`);
	}

	console.log(`SEA smoke test passed (${versionOut.trim()}, ${url})`);
} finally {
	child.kill("SIGTERM");
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	await Promise.race([exited, delay(5_000)]);
	if (child.exitCode === null) child.kill("SIGKILL");
	await rm(home, { recursive: true, force: true });
}
