import { assert, assertEquals } from "@std/assert";
import {
	expandMentions,
	getGitBranch,
	isGitRepo,
	listProjectFiles,
	resolveWithinRoot,
	validateWorkspacePath,
	validateWorkspacePathSync,
} from "@/core/workspace.ts";

// ---------------------------------------------------------------------------
// resolveWithinRoot
// ---------------------------------------------------------------------------

Deno.test("resolveWithinRoot resolves relative paths inside the root", () => {
	assertEquals(resolveWithinRoot("/a/b", "c/d.txt"), "/a/b/c/d.txt");
	assertEquals(resolveWithinRoot("/a/b", "./c"), "/a/b/c");
	assertEquals(resolveWithinRoot("/a/b", "."), "/a/b");
});

Deno.test("resolveWithinRoot rejects paths escaping the root", () => {
	assertEquals(resolveWithinRoot("/a/b", "../x"), null);
	assertEquals(resolveWithinRoot("/a/b", "../../etc/passwd"), null);
	assertEquals(resolveWithinRoot("/a/b", "/etc/passwd"), null);
	assertEquals(resolveWithinRoot("/a/b", "c/../../../d"), null);
});

Deno.test("resolveWithinRoot does not confuse sibling prefixes with the root", () => {
	assertEquals(resolveWithinRoot("/a/b", "../bb/x"), null);
});

// ---------------------------------------------------------------------------
// expandMentions
// ---------------------------------------------------------------------------

Deno.test("expandMentions appends file contents as attached context", async () => {
	const dir = await Deno.makeTempDir();
	try {
		await Deno.writeTextFile(`${dir}/hello.txt`, "hello world");

		const result = await expandMentions("look at @hello.txt please", dir);

		assert(result.startsWith("look at @hello.txt please"));
		assert(result.includes("<attached_context>"));
		assert(result.includes("--- hello.txt ---\nhello world"));
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("expandMentions expands directories recursively, skipping ignored dirs", async () => {
	const dir = await Deno.makeTempDir();
	try {
		await Deno.mkdir(`${dir}/src`);
		await Deno.mkdir(`${dir}/node_modules`);
		await Deno.writeTextFile(`${dir}/src/a.ts`, "const a = 1;");
		await Deno.writeTextFile(`${dir}/node_modules/skip.js`, "nope");

		const result = await expandMentions("check @src", dir);

		assert(result.includes("--- src/a.ts ---\nconst a = 1;"));
		assert(!result.includes("skip.js"));
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("expandMentions leaves unknown mentions as-is", async () => {
	const dir = await Deno.makeTempDir();
	try {
		const result = await expandMentions("what is @missing.ts?", dir);
		assertEquals(result, "what is @missing.ts?");
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("expandMentions leaves mentions escaping the root as-is", async () => {
	const parent = await Deno.makeTempDir();
	try {
		const root = `${parent}/project`;
		await Deno.mkdir(root);
		await Deno.writeTextFile(`${parent}/secret.txt`, "top secret");

		const result = await expandMentions("read @../secret.txt", root);

		assertEquals(result, "read @../secret.txt");
	} finally {
		await Deno.remove(parent, { recursive: true });
	}
});

Deno.test("expandMentions rejects symlinks that resolve outside the root", async () => {
	const parent = await Deno.makeTempDir();
	try {
		const root = `${parent}/project`;
		await Deno.mkdir(root);
		await Deno.writeTextFile(`${parent}/secret.txt`, "top secret");
		await Deno.mkdir(`${parent}/outside`);
		await Deno.writeTextFile(`${parent}/outside/secret.txt`, "directory secret");
		await Deno.symlink(`${parent}/secret.txt`, `${root}/file-link.txt`);
		await Deno.symlink(`${parent}/outside`, `${root}/dir-link`);

		const result = await expandMentions("read @file-link.txt and @dir-link", root);

		assertEquals(result, "read @file-link.txt and @dir-link");
	} finally {
		await Deno.remove(parent, { recursive: true });
	}
});

Deno.test("expandMentions normalizes duplicate mentions and truncates large files", async () => {
	const dir = await Deno.makeTempDir();
	try {
		await Deno.mkdir(`${dir}/src`);
		await Deno.writeTextFile(`${dir}/src/a.ts`, "a".repeat(10_001));

		const result = await expandMentions("check @src @src/", dir);

		assertEquals(result.match(/--- src\/a\.ts ---/g)?.length, 1);
		assert(result.includes("...(truncated)"));
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("expandMentions does not treat email addresses as mentions", async () => {
	const dir = await Deno.makeTempDir();
	try {
		assertEquals(await expandMentions("email user@example.com", dir), "email user@example.com");
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

// ---------------------------------------------------------------------------
// listProjectFiles / isGitRepo / getGitBranch
// ---------------------------------------------------------------------------

Deno.test("listProjectFiles walks directories, skipping ignored dirs", async () => {
	const dir = await Deno.makeTempDir();
	try {
		await Deno.mkdir(`${dir}/src`);
		await Deno.mkdir(`${dir}/node_modules`);
		await Deno.writeTextFile(`${dir}/src/a.ts`, "");
		await Deno.writeTextFile(`${dir}/node_modules/skip.js`, "");

		const files = await listProjectFiles(dir);

		assert(files.includes("src/"));
		assert(files.includes("src/a.ts"));
		assert(!files.some((f) => f.includes("node_modules")));
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("isGitRepo detects .git directories", async () => {
	const dir = await Deno.makeTempDir();
	try {
		assertEquals(await isGitRepo(dir), false);
		await new Deno.Command("git", { args: ["init"], cwd: dir, stdout: "null", stderr: "null" }).output();
		assertEquals(await isGitRepo(dir), true);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("listProjectFiles uses git ls-files in repos", async () => {
	const dir = await Deno.makeTempDir();
	try {
		await new Deno.Command("git", { args: ["init"], cwd: dir, stdout: "null", stderr: "null" }).output();
		await Deno.writeTextFile(`${dir}/tracked.ts`, "");
		await Deno.writeTextFile(`${dir}/.gitignore`, "ignored.txt\n");
		await Deno.writeTextFile(`${dir}/ignored.txt`, "");

		const files = await listProjectFiles(dir);

		assert(files.includes("tracked.ts"));
		assert(!files.includes("ignored.txt"));
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("getGitBranch returns null outside a git repo", async () => {
	const dir = await Deno.makeTempDir();
	try {
		assertEquals(await getGitBranch(dir), null);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("listProjectFiles returns an empty list for a missing directory", async () => {
	const dir = `${await Deno.makeTempDir()}/gone`;
	assertEquals(await listProjectFiles(dir), []);
});

// ---------------------------------------------------------------------------
// validateWorkspacePath
// ---------------------------------------------------------------------------

Deno.test("validateWorkspacePath accepts an existing directory and canonicalizes it", async () => {
	const dir = await Deno.makeTempDir();
	try {
		const result = await validateWorkspacePath(`${dir}/`, []);
		assertEquals(result, { ok: true, path: await Deno.realPath(dir) });
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("validateWorkspacePath rejects empty and non-string input", async () => {
	assertEquals((await validateWorkspacePath("", [])).ok, false);
	assertEquals((await validateWorkspacePath("   ", [])).ok, false);
	assertEquals((await validateWorkspacePath(undefined, [])).ok, false);
	assertEquals((await validateWorkspacePath(42, [])).ok, false);
});

Deno.test("validateWorkspacePath rejects relative paths before resolving them", async () => {
	const result = await validateWorkspacePath("./relative", []);
	assertEquals(result.ok, false);
	if (!result.ok) assertEquals(result.reason, "not-absolute");
});

Deno.test("validateWorkspacePath rejects missing paths and files", async () => {
	const dir = await Deno.makeTempDir();
	try {
		const missing = await validateWorkspacePath(`${dir}/nope`, []);
		assertEquals(missing.ok, false);
		if (!missing.ok) assertEquals(missing.reason, "missing");

		const file = `${dir}/file.txt`;
		await Deno.writeTextFile(file, "");
		const notDir = await validateWorkspacePath(file, []);
		assertEquals(notDir.ok, false);
		if (!notDir.ok) assertEquals(notDir.reason, "not-a-directory");
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("validateWorkspacePath enforces roots against the canonical path", async () => {
	const parent = await Deno.makeTempDir();
	try {
		const root = `${parent}/root`;
		const inside = `${root}/project`;
		const outside = `${parent}/outside`;
		await Deno.mkdir(inside, { recursive: true });
		await Deno.mkdir(outside, { recursive: true });

		const allowed = await validateWorkspacePath(inside, [root]);
		assertEquals(allowed.ok, true);

		const denied = await validateWorkspacePath(outside, [root]);
		assertEquals(denied.ok, false);
		if (!denied.ok) assertEquals(denied.reason, "outside-roots");
	} finally {
		await Deno.remove(parent, { recursive: true });
	}
});

Deno.test("validateWorkspacePath rejects a symlink that escapes the root", async () => {
	const parent = await Deno.makeTempDir();
	try {
		const root = `${parent}/root`;
		const outside = `${parent}/outside`;
		await Deno.mkdir(root);
		await Deno.mkdir(outside);
		await Deno.symlink(outside, `${root}/link`);

		const result = await validateWorkspacePath(`${root}/link`, [root]);
		assertEquals(result.ok, false);
		if (!result.ok) assertEquals(result.reason, "outside-roots");
	} finally {
		await Deno.remove(parent, { recursive: true });
	}
});

Deno.test("validateWorkspacePath treats an empty root list as allow-anywhere", async () => {
	const dir = await Deno.makeTempDir();
	try {
		assertEquals((await validateWorkspacePath(dir, [])).ok, true);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});

Deno.test("validateWorkspacePathSync matches the async contract", async () => {
	const dir = await Deno.makeTempDir();
	try {
		const sync = validateWorkspacePathSync(dir, [dir]);
		const asyncResult = await validateWorkspacePath(dir, [dir]);
		assertEquals(sync, asyncResult);

		const relative = validateWorkspacePathSync("relative", []);
		assertEquals(relative.ok, false);
		if (!relative.ok) assertEquals(relative.reason, "not-absolute");
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});
