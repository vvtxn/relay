export { createToolRegistry, defineTool, getDefinitions, ToolError } from "./types.ts";
export type { Tool, ToolRegistry, ToolResult } from "./types.ts";
export { type ApprovalHandler, type ApprovalOptions, withApproval } from "./approval.ts";
export { createDelegateTool, type DelegateToolOptions } from "./delegate.ts";

import { basename, dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { Effect } from "effect";
import { resolveRealWithinRoot, resolveWithinRoot } from "../workspace.ts";
import { bashTool, createBashTool } from "./bash.ts";
import { editFileTool } from "./edit.ts";
import { grepTool } from "./grep.ts";
import { readFileTool } from "./read.ts";
import { writeFileTool } from "./write.ts";
import { toToolError, type Tool } from "./types.ts";

/** All built-in tools. */
export const defaultTools: Tool[] = [bashTool, readFileTool, writeFileTool, editFileTool, grepTool];

/**
 * Synchronous lock key for a file tool's `path` argument: the canonical path
 * inside the root (symlinks resolved when they can be, so aliases of the same
 * file share one key). Escaping paths collapse into one key — they are rejected
 * before touching the filesystem anyway.
 */
function fileResourceKey(root: string, input: unknown): string {
	const obj = (input ?? {}) as Record<string, unknown>;
	const rel = typeof obj.path === "string" ? obj.path : ".";
	const abs = resolveWithinRoot(root, rel);
	if (!abs) return "outside-root";
	try {
		return realpathSync(abs);
	} catch {
		// The file may not exist yet (e.g. write_file): canonicalize the parent.
		try {
			return join(realpathSync(dirname(abs)), basename(abs));
		} catch {
			return abs;
		}
	}
}

/**
 * Rewrites a tool's `path` argument to an absolute path inside `root`,
 * rejecting paths that escape it (including via symlinks). Tools without a
 * path argument (only grep, which defaults to ".") search the root itself.
 *
 * The wrapper also marks the tool as `confined` (so approval layers can treat
 * it as sandboxed) and attaches the resolved path as the tool's `resourceKey`,
 * so the agent loop serializes concurrent calls that touch the same file.
 */
function confinePathArg(tool: Tool, root: string): Tool {
	return {
		...tool,
		confined: true,
		resourceKey: (input) => fileResourceKey(root, input),
		execute: (input) =>
			Effect.gen(function* () {
				const obj = (input ?? {}) as Record<string, unknown>;
				const rel = typeof obj.path === "string" ? obj.path : ".";
				const abs = yield* Effect.tryPromise({
					try: () => resolveRealWithinRoot(root, rel),
					catch: toToolError,
				});
				if (!abs) {
					return {
						content: `Path "${rel}" is outside the workspace. Use a path inside the workspace directory.`,
						isError: true,
					};
				}
				return yield* tool.execute({ ...obj, path: abs });
			}),
	};
}

/**
 * Creates the built-in tools rooted at a workspace directory: file tools
 * resolve (and confine) paths against `root`, and bash commands run with
 * `root` as their working directory.
 *
 * Note: this confines file tools genuinely, but bash only gets a default cwd
 * — a shell command can still reference absolute paths outside the root. For
 * untrusted environments, pair with OS-level isolation.
 */
export function createWorkspaceTools(root: string): Tool[] {
	return [
		createBashTool(root),
		confinePathArg(readFileTool, root),
		confinePathArg(writeFileTool, root),
		confinePathArg(editFileTool, root),
		confinePathArg(grepTool, root),
	];
}
