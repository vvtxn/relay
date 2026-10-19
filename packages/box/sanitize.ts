import { lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, matchesGlob, relative, sep } from "node:path";

const SECRET_FILES = new Set([
	".npmrc",
	".yarnrc.yml",
	".pypirc",
	".netrc",
	"_netrc",
	".git-credentials",
	"id_rsa",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
]);

const SECRET_DIRS = new Set([".ssh", ".aws", ".kube"]);

const ENV_EXAMPLES = new Set([".env.example", ".env.sample", ".env.template"]);

function relativePath(root: string, path: string): string {
	return relative(root, path).split(sep).join("/");
}

function matchesProjectExclude(rel: string, patterns: string[]): boolean {
	for (const pattern of patterns) {
		if (matchesGlob(rel, pattern)) return true;
		if (!pattern.includes("/") && matchesGlob(basename(rel), pattern)) return true;
	}
	return false;
}

function isSecretFile(name: string): boolean {
	if (SECRET_FILES.has(name)) return true;
	if (name === ".env" || name.startsWith(".env.")) return !ENV_EXAMPLES.has(name);
	return false;
}

/**
 * Remove host credentials and user-specific state from a workspace clone.
 * Nothing here touches the source checkout.
 */
export async function sanitizeWorkspace(root: string, projectExcludes: string[] = []): Promise<string[]> {
	const removed: string[] = [];

	async function walk(dir: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const abs = join(dir, entry.name);
			const rel = relativePath(root, abs);

			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (rel === ".relay" || SECRET_DIRS.has(entry.name) || matchesProjectExclude(rel, projectExcludes)) {
					await rm(abs, { recursive: true, force: true });
					removed.push(rel);
					continue;
				}
				await walk(abs);
				continue;
			}
			if (!entry.isFile()) continue;
			if (isSecretFile(entry.name) || matchesProjectExclude(rel, projectExcludes)) {
				await rm(abs, { force: true });
				removed.push(rel);
			}
		}
	}

	await walk(root);
	await stripGitCredentials(root);
	removed.sort();
	return removed;
}

/** Drop userinfo from remote URLs in .git/config without rewriting the source. */
async function stripGitCredentials(root: string): Promise<void> {
	const path = join(root, ".git", "config");
	try {
		const info = await lstat(path);
		if (!info.isFile()) return;
	} catch {
		return;
	}
	try {
		const original = await readFile(path, "utf8");
		const scrubbed = original.replace(/(\bhttps?:\/\/)[^/@\s]+@/g, "$1");
		if (scrubbed !== original) await writeFile(path, scrubbed, "utf8");
	} catch {
		// A malformed or unreadable config is not worth failing the box for.
	}
}
