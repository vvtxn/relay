// Local and cloud servers must never share state/log files.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { serverLogPath, serverStatePath } from "@vvtxn/relay/core/server-state.ts";

const originalHome = process.env.HOME;
afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
});

describe("server state paths", () => {
	it("separates local and cloud state and logs", () => {
		process.env.HOME = join(tmpdir(), "relay-state-home");
		expect(serverStatePath("local")).toBe(join(tmpdir(), "relay-state-home", ".relay", "server-local.json"));
		expect(serverStatePath("cloud")).toBe(join(tmpdir(), "relay-state-home", ".relay", "server-cloud.json"));
		expect(serverLogPath("local")).toBe(join(tmpdir(), "relay-state-home", ".relay", "logs", "server-local.log"));
		expect(serverLogPath("cloud")).toBe(join(tmpdir(), "relay-state-home", ".relay", "logs", "server-cloud.log"));
	});

	it("defaults to cloud and keeps explicit legacy names", () => {
		process.env.HOME = join(tmpdir(), "relay-state-home");
		delete process.env.RELAY_FLAVOR;
		expect(serverStatePath()).toBe(join(tmpdir(), "relay-state-home", ".relay", "server-cloud.json"));
		expect(serverLogPath()).toBe(join(tmpdir(), "relay-state-home", ".relay", "logs", "server-cloud.log"));
		expect(serverStatePath(null)).toBe(join(tmpdir(), "relay-state-home", ".relay", "server.json"));
		expect(serverLogPath(null)).toBe(join(tmpdir(), "relay-state-home", ".relay", "logs", "server.log"));
	});
});
