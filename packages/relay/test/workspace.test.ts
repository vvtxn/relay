// Tests for path confinement: lexical resolution and symlink-safe resolution,
// including paths whose parent directories do not exist yet.

import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { resolveRealWithinRoot, resolveWithinRoot } from "../core/workspace.ts";

function tempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "relay-workspace-test-"));
}

describe("resolveWithinRoot", () => {
	it("resolves inside paths lexically and rejects escapes", async () => {
		const root = await tempRoot();

		expect(resolveWithinRoot(root, "a/b.txt")).toBe(join(root, "a/b.txt"));
		expect(resolveWithinRoot(root, "../outside")).toBeNull();
		expect(resolveWithinRoot(root, "/etc/passwd")).toBeNull();
	});
});

describe("resolveRealWithinRoot", () => {
	it("resolves a path whose parent directories do not exist yet", async () => {
		const root = await tempRoot();
		const realRoot = await realpath(root);

		expect(await resolveRealWithinRoot(root, "src/deep/new.ts")).toBe(join(realRoot, "src/deep/new.ts"));
	});

	it("resolves existing files through their real path", async () => {
		const root = await tempRoot();
		const realRoot = await realpath(root);
		await writeFile(join(root, "real.txt"), "x");
		await symlink("real.txt", join(root, "link.txt"));

		expect(await resolveRealWithinRoot(root, "link.txt")).toBe(join(realRoot, "real.txt"));
	});

	it("rejects an escaping symlinked ancestor even when the file is missing", async () => {
		const root = await tempRoot();
		const outside = await tempRoot();
		await symlink(outside, join(root, "escape"));

		expect(await resolveRealWithinRoot(root, "escape/new.txt")).toBeNull();
	});

	it("rejects a dangling symlink instead of treating it as creatable", async () => {
		const root = await tempRoot();
		await symlink(join(root, "missing-target.txt"), join(root, "dangling.txt"));

		expect(await resolveRealWithinRoot(root, "dangling.txt")).toBeNull();
	});

	it("rejects paths outside the root", async () => {
		const root = await tempRoot();

		expect(await resolveRealWithinRoot(root, "../outside.txt")).toBeNull();
		expect(await resolveRealWithinRoot(root, "/tmp/abs-outside.txt")).toBeNull();
	});
});
