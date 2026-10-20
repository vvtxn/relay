import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { parseProjectConfig, resolveBoxSettings } from "../config.ts";
import { prepareWorkspace } from "../workspace.ts";

async function projectFixture(): Promise<{ root: string; project: string; boxDir: string; workspace: string }> {
	const root = await mkdtemp(join(tmpdir(), "relay-box-workspace-"));
	const project = join(root, "project");
	const boxDir = join(root, "boxes", "box-1");
	const workspace = join(boxDir, "workspace");
	await mkdir(join(project, "src"), { recursive: true });
	await mkdir(join(project, ".git"), { recursive: true });
	await mkdir(join(project, ".relay"), { recursive: true });
	await writeFile(join(project, "src", "app.ts"), "export const x = 1;\n");
	await writeFile(join(project, ".env"), "SECRET=should-not-copy\n");
	await writeFile(join(project, ".env.example"), "SECRET=\n");
	await writeFile(join(project, ".npmrc"), "//registry.example.com/:_authToken=secret\n");
	await writeFile(join(project, ".relay", "box.json"), '{"version":1}\n');
	await writeFile(
		join(project, ".git", "config"),
		'[remote "origin"]\n\turl = https://user:pass@example.com/repo.git\n',
	);
	return { root, project, boxDir, workspace };
}

describe("prepareWorkspace", () => {
	it("copies the working tree and removes host secrets", async () => {
		const { project, boxDir, workspace } = await projectFixture();
		const removed = await prepareWorkspace(project, boxDir, workspace, []);
		expect(existsSync(join(workspace, "src", "app.ts"))).toBe(true);
		expect(existsSync(join(workspace, ".env"))).toBe(false);
		expect(existsSync(join(workspace, ".npmrc"))).toBe(false);
		expect(existsSync(join(workspace, ".relay"))).toBe(false);
		expect(existsSync(join(workspace, ".env.example"))).toBe(true);
		expect(removed).toEqual(expect.arrayContaining([".env", ".npmrc"]));
		const gitConfig = await readFile(join(workspace, ".git", "config"), "utf8");
		expect(gitConfig).not.toContain("user:pass");
		expect(gitConfig).toContain("https://example.com/repo.git");
	});

	it("applies project excludes but keeps normal files", async () => {
		const { project, boxDir, workspace } = await projectFixture();
		await prepareWorkspace(project, boxDir, workspace, ["src/**"]);
		expect(existsSync(join(workspace, "src", "app.ts"))).toBe(false);
		expect(existsSync(join(workspace, ".env.example"))).toBe(true);
	});
});

describe("project config", () => {
	it("merges project values over server defaults", () => {
		const defaults = {
			image: "default:latest",
			cpus: 2,
			memoryMiB: 2048,
			rootDiskMiB: 8192,
			setup: "default setup",
			env: { A: "1" },
			exclude: [],
		};
		const project = parseProjectConfig({
			version: 1,
			image: "project:latest",
			memoryMiB: 4096,
			setup: "project setup",
			env: { B: "2" },
			exclude: ["dist"],
		});
		expect(resolveBoxSettings(defaults, project)).toMatchObject({
			image: "project:latest",
			cpus: 2,
			memoryMiB: 4096,
			setup: "project setup",
			env: { A: "1", B: "2" },
			exclude: ["dist"],
		});
	});

	it("rejects unknown fields and invalid values", () => {
		expect(() => parseProjectConfig({ version: 1, unknown: true })).toThrow("Unknown");
		expect(() => parseProjectConfig({ version: 1, cpus: 0 })).toThrow("positive integer");
		expect(() => parseProjectConfig({ version: 2 })).toThrow("Unsupported");
	});
});
