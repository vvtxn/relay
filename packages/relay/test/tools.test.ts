// Tests for the workspace tool wrapper: the resource keys the agent loop uses
// to serialize concurrent operations on the same file.

import { symlink, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { createWorkspaceTools } from "../core/tools/index.ts";

function workspace(): Promise<string> {
	return mkdtemp(join(tmpdir(), "relay-tools-test-"));
}

function toolNamed(tools: ReturnType<typeof createWorkspaceTools>, name: string) {
	const tool = tools.find((candidate) => candidate.definition.function.name === name);
	if (!tool) throw new Error(`tool ${name} not found`);
	return tool;
}

describe("workspace tool resource keys", () => {
	it("derives one key per file across path spellings", async () => {
		const root = await workspace();
		const write = toolNamed(createWorkspaceTools(root), "write_file");

		const key = write.resourceKey?.({ path: "src/a.ts" });
		expect(key).toBeDefined();
		expect(write.resourceKey?.({ path: "./src/a.ts" })).toBe(key);
		expect(write.resourceKey?.({ path: "src/b.ts" })).not.toBe(key);
	});

	it("shares a key between a file and a symlink alias", async () => {
		const root = await workspace();
		await writeFile(join(root, "real.txt"), "content");
		await symlink("real.txt", join(root, "link.txt"));

		const edit = toolNamed(createWorkspaceTools(root), "edit_file");
		expect(edit.resourceKey?.({ path: "link.txt" })).toBe(edit.resourceKey?.({ path: "real.txt" }));
	});

	it("keeps bash exclusive by leaving it without a key", async () => {
		const root = await workspace();
		const bash = toolNamed(createWorkspaceTools(root), "bash");
		expect(bash.resourceKey).toBeUndefined();
	});

	it("marks the confined file tools and leaves bash unconfined", async () => {
		const root = await workspace();
		const tools = createWorkspaceTools(root);

		for (const name of ["read_file", "write_file", "edit_file", "grep"]) {
			expect(toolNamed(tools, name).confined).toBe(true);
		}
		expect(toolNamed(tools, "bash").confined).toBeUndefined();
	});

	it("creates missing parent directories when writing a nested file", async () => {
		const root = await workspace();
		const write = toolNamed(createWorkspaceTools(root), "write_file");

		const result = await Effect.runPromise(write.execute({ path: "src/nested/mod.ts", content: "export {};" }));

		expect(result.isError).not.toBe(true);
		expect(await readFile(join(root, "src/nested/mod.ts"), "utf8")).toBe("export {};");
	});
});
