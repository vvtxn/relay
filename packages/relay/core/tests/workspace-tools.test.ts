import { assert, assertEquals } from "@std/assert";
import { createToolRegistry, createWorkspaceTools } from "@/core/tools/index.ts";
import type { Tool, ToolRegistry } from "@/core/tools/types.ts";

function registry(root: string): ToolRegistry {
	return createToolRegistry(createWorkspaceTools(root));
}

function tool(reg: ToolRegistry, name: string): Tool {
	const t = reg.get(name);
	if (!t) throw new Error(`tool ${name} not found`);
	return t;
}

Deno.test("workspace tools read files inside the root via relative paths", async () => {
	const dir = await Deno.makeTempDir();
	try {
		await Deno.writeTextFile(`${dir}/hello.txt`, "hello workspace");
		const tools = registry(dir);

		const result = await tool(tools, "read_file").execute({ path: "hello.txt" });

		assertEquals(result.isError, undefined);
		assertEquals(result.content, "hello workspace");
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("workspace tools write files inside the root", async () => {
	const dir = await Deno.makeTempDir();
	try {
		const tools = registry(dir);

		const result = await tool(tools, "write_file").execute({ path: "out.txt", content: "written" });

		assertEquals(result.isError, undefined);
		assertEquals(await Deno.readTextFile(`${dir}/out.txt`), "written");
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("workspace tools reject paths escaping the root", async () => {
	const parent = await Deno.makeTempDir();
	try {
		const root = `${parent}/project`;
		await Deno.mkdir(root);
		await Deno.writeTextFile(`${parent}/secret.txt`, "top secret");
		const tools = registry(root);

		for (
			const [name, input] of [
				["read_file", { path: "../secret.txt" }],
				["write_file", { path: "../escape.txt", content: "x" }],
				["edit_file", { path: "../secret.txt", old_str: "top", new_str: "not" }],
				["grep", { pattern: "secret", path: ".." }],
			] as const
		) {
			const result = await tool(tools, name).execute(input);
			assertEquals(result.isError, true, `${name} should reject escaping path`);
			assert(result.content.includes("outside the workspace"), `${name} should explain the confinement`);
		}

		assertEquals(await Deno.readTextFile(`${parent}/secret.txt`), "top secret");
		assertEquals(
			await Deno.stat(`${parent}/escape.txt`).then(() => true).catch(() => false),
			false,
			"no file should be written outside the root",
		);
	} finally {
		await Deno.remove(parent, { recursive: true });
	}
});

Deno.test("workspace tools reject symlinks that escape the root", async () => {
	const parent = await Deno.makeTempDir();
	try {
		const root = `${parent}/project`;
		await Deno.mkdir(root);
		await Deno.writeTextFile(`${parent}/secret.txt`, "top secret");
		await Deno.symlink(`${parent}/secret.txt`, `${root}/link.txt`);
		const tools = registry(root);

		const result = await tool(tools, "read_file").execute({ path: "link.txt" });

		assertEquals(result.isError, true);
		assert(result.content.includes("outside the workspace"));
	} finally {
		await Deno.remove(parent, { recursive: true });
	}
});

Deno.test("workspace tools accept absolute paths inside the root", async () => {
	const dir = await Deno.makeTempDir();
	try {
		await Deno.writeTextFile(`${dir}/abs.txt`, "absolute");
		const tools = registry(dir);

		const result = await tool(tools, "read_file").execute({ path: `${dir}/abs.txt` });

		assertEquals(result.isError, undefined);
		assertEquals(result.content, "absolute");
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("workspace bash runs commands with the root as cwd", async () => {
	const dir = await Deno.makeTempDir();
	try {
		const tools = registry(dir);

		const result = await tool(tools, "bash").execute({ command: "pwd" });

		assert(!result.isError);
		assertEquals(result.content.trim(), dir);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("workspace grep defaults to searching the root", async () => {
	const dir = await Deno.makeTempDir();
	try {
		await Deno.writeTextFile(`${dir}/match.ts`, "const needle = 1;");
		const tools = registry(dir);

		const result = await tool(tools, "grep").execute({ pattern: "needle" });

		assertEquals(result.isError, undefined);
		assert(result.content.includes("match.ts"));
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});
