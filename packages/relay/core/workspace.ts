/**
 * Workspace helpers — filesystem operations rooted at an explicit directory.
 *
 * The workspace root is the directory an agent session operates in: the CLI
 * passes `Deno.cwd()`, a server passes a per-session workspace directory.
 * Every helper takes the root explicitly so the caller controls confinement.
 */

import { basename, dirname, join, resolve, SEPARATOR } from "@std/path";

const IGNORE_DIRS = new Set([".git", "node_modules", "dist", "out", "build", "coverage", ".next", "target", ".cache"]);
const MAX_FILES = 10_000;
const MENTION_RE = /(?:^|\s)@([\w./_-]+\/?)/g;
const MAX_MENTION_OUTPUT = 10_000;
const MAX_MENTION_DEPTH = 8;

/**
 * Resolves `rel` against `root`, returning the absolute path — or null when
 * the result escapes the root (e.g. via `..` or an absolute path).
 */
export function resolveWithinRoot(root: string, rel: string): string | null {
	const normalizedRoot = resolve(root);
	const abs = resolve(normalizedRoot, rel);
	return abs === normalizedRoot || abs.startsWith(normalizedRoot + SEPARATOR) ? abs : null;
}

export async function isGitRepo(root: string): Promise<boolean> {
	try {
		const stat = await Deno.stat(`${root}/.git`);
		return stat.isDirectory;
	} catch {
		return false;
	}
}

/** Returns the current git branch for the workspace, or null when unavailable (not a repo, detached, no git). */
export async function getGitBranch(root: string): Promise<string | null> {
	try {
		const result = await new Deno.Command("git", {
			args: ["branch", "--show-current"],
			cwd: root,
			stdout: "piped",
			stderr: "null",
		}).output();
		if (!result.success) return null;
		return new TextDecoder().decode(result.stdout).trim() || null;
	} catch {
		return null;
	}
}

async function listFilesGit(root: string): Promise<string[]> {
	const result = await new Deno.Command("git", {
		args: ["ls-files", "--cached", "--others", "--exclude-standard"],
		cwd: root,
		stdout: "piped",
		stderr: "piped",
	}).output();
	if (!result.success) throw new Error("git ls-files failed");
	const files = new TextDecoder().decode(result.stdout).trim().split("\n").filter(Boolean);

	const dirs = new Set<string>();
	for (const f of files) {
		let idx = f.indexOf("/");
		while (idx !== -1) {
			dirs.add(f.slice(0, idx) + "/");
			idx = f.indexOf("/", idx + 1);
		}
	}

	return [...dirs, ...files].slice(0, MAX_FILES);
}

async function listFilesWalk(root: string): Promise<string[]> {
	const files: string[] = [];

	async function walk(dir: string, prefix: string) {
		if (files.length >= MAX_FILES) return;
		for await (const entry of Deno.readDir(dir)) {
			if (files.length >= MAX_FILES) return;
			if (entry.isDirectory) {
				if (IGNORE_DIRS.has(entry.name)) continue;
				const dirPath = prefix ? `${prefix}/${entry.name}` : entry.name;
				files.push(dirPath + "/");
				await walk(`${dir}/${entry.name}`, dirPath);
			} else if (entry.isFile) {
				files.push(prefix ? `${prefix}/${entry.name}` : entry.name);
			}
		}
	}

	await walk(root, "");
	return files;
}

/**
 * Lists project files relative to `root`: tracked + untracked files
 * (respecting .gitignore) in git repos, a recursive walk otherwise.
 */
export async function listProjectFiles(root: string): Promise<string[]> {
	if (await isGitRepo(root)) {
		try {
			return await listFilesGit(root);
		} catch {
			// git failed (e.g. not installed) — fall back to walking
		}
	}
	return await listFilesWalk(root);
}

async function readDirRecursive(absDir: string, relDir: string, root: string): Promise<string> {
	const parts: string[] = [];
	let totalLen = 0;
	let truncated = false;

	async function walk(abs: string, rel: string, depth: number) {
		if (truncated) return;
		let entries: Deno.DirEntry[];
		try {
			entries = await Array.fromAsync(Deno.readDir(abs));
		} catch {
			return;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (truncated) return;
			if (entry.isSymlink) continue;
			const absPath = `${abs}/${entry.name}`;
			const relPath = `${rel}/${entry.name}`;
			if (entry.isDirectory) {
				if (IGNORE_DIRS.has(entry.name)) continue;
				if (depth >= MAX_MENTION_DEPTH) continue;
				if (!await realPathWithinRoot(root, absPath)) continue;
				await walk(absPath, relPath, depth + 1);
			} else if (entry.isFile) {
				if (!await realPathWithinRoot(root, absPath)) continue;
				try {
					const content = await Deno.readTextFile(absPath);
					const header = `--- ${relPath} ---\n`;
					const section = header + content + "\n\n";
					if (totalLen + section.length > MAX_MENTION_OUTPUT) {
						const remaining = MAX_MENTION_OUTPUT - totalLen;
						if (remaining > header.length) parts.push(header + content.slice(0, remaining - header.length));
						truncated = true;
						return;
					}
					parts.push(section);
					totalLen += section.length;
				} catch {
					// skip binary / unreadable
				}
			}
		}
	}

	await walk(absDir.replace(/\/+$/, ""), relDir.replace(/\/+$/, ""), 0);
	let result = parts.join("");
	if (truncated) result += "\n...(truncated)";
	return result || "(empty directory)";
}

async function realPathWithinRoot(root: string, absPath: string): Promise<string | null> {
	try {
		const [realRoot, realPath] = await Promise.all([Deno.realPath(root), Deno.realPath(absPath)]);
		return realPath === realRoot || realPath.startsWith(realRoot + SEPARATOR) ? realPath : null;
	} catch {
		return null;
	}
}

/**
 * Like {@link resolveWithinRoot}, but also resolves symlinks so a link inside
 * the root cannot be used to reach outside it. For a path that does not exist
 * yet (e.g. a new file), the parent directory is resolved and the basename is
 * appended, so the check still applies.
 */
export async function resolveRealWithinRoot(root: string, rel: string): Promise<string | null> {
	const abs = resolveWithinRoot(root, rel);
	if (!abs) return null;

	// If the path exists (including as a symlink), its realpath must stay in
	// the root. `lstat` does not follow the final symlink, so an escaping link
	// is detected rather than treated as a missing path.
	let exists = true;
	try {
		await Deno.lstat(abs);
	} catch {
		exists = false;
	}
	if (exists) return await realPathWithinRoot(root, abs);

	const realParent = await realPathWithinRoot(root, dirname(abs));
	return realParent ? join(realParent, basename(abs)) : null;
}

/**
 * Expands `@path` mentions in `text` by appending file/directory contents as
 * an `<attached_context>` block. Paths are resolved within `root`; mentions
 * that escape the root or don't exist are left as-is.
 */
export async function expandMentions(text: string, root: string): Promise<string> {
	const seen = new Set<string>();
	const mentions: string[] = [];

	for (const match of text.matchAll(MENTION_RE)) {
		const relPath = (match[1] ?? "").replace(/\/+$/, "");
		if (!relPath) continue;
		if (seen.has(relPath)) continue;
		seen.add(relPath);
		mentions.push(relPath);
	}

	const contextBlocks = await Promise.all(mentions.map(async (relPath) => {
		const absPath = resolveWithinRoot(root, relPath);
		if (!absPath) return null;

		try {
			const realPath = await realPathWithinRoot(root, absPath);
			if (!realPath) return null;
			const stat = await Deno.stat(realPath);
			if (stat.isDirectory) {
				return await readDirRecursive(realPath, relPath, root);
			} else if (stat.isFile) {
				const raw = await Deno.readTextFile(realPath);
				const content = raw.length > MAX_MENTION_OUTPUT
					? raw.slice(0, MAX_MENTION_OUTPUT) + "\n...(truncated)"
					: raw;
				return `--- ${relPath} ---\n${content}`;
			}
		} catch {
			// path doesn't exist or can't be read — leave mention as-is
		}
		return null;
	}));
	const blocks = contextBlocks.filter((block): block is string => block !== null);

	if (blocks.length === 0) return text;

	return `${text}\n\n<attached_context>\n${blocks.join("\n\n")}\n</attached_context>`;
}
