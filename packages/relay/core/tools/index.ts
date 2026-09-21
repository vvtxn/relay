export { createToolRegistry, defineTool, getDefinitions } from "./types.ts";
export type { Tool, ToolRegistry, ToolResult } from "./types.ts";
export { type ApprovalHandler, type ApprovalOptions, withApproval } from "./approval.ts";

import { resolveRealWithinRoot } from "@/core/workspace.ts";
import { bashTool, createBashTool } from "./bash.ts";
import { editFileTool } from "./edit.ts";
import { grepTool } from "./grep.ts";
import { readFileTool } from "./read.ts";
import { writeFileTool } from "./write.ts";
import type { Tool } from "./types.ts";

/** All built-in tools. */
export const defaultTools: Tool[] = [
	bashTool,
	readFileTool,
	writeFileTool,
	editFileTool,
	grepTool,
];

/**
 * Rewrites a tool's `path` argument to an absolute path inside `root`,
 * rejecting paths that escape it (including via symlinks). Tools without a
 * path argument (only grep, which defaults to ".") search the root itself.
 */
function confinePathArg(tool: Tool, root: string): Tool {
	return {
		...tool,
		execute: async (input) => {
			const obj = (input ?? {}) as Record<string, unknown>;
			const rel = typeof obj.path === "string" ? obj.path : ".";
			const abs = await resolveRealWithinRoot(root, rel);
			if (!abs) {
				return {
					content: `Path "${rel}" is outside the workspace. Use a path inside the workspace directory.`,
					isError: true,
				};
			}
			return await tool.execute({ ...obj, path: abs });
		},
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
