import { createSignal } from "solid-js";
import { abbreviateHome, expandHome } from "@vvtxn/relay/core/display.ts";
import { readStoredCwd, writeStoredCwd } from "#/api/storage.ts";

const [homeDir, setHomeDirSignal] = createSignal("");
export { homeDir };

/** Record the server's home directory for path abbreviation/expansion. */
export function setHomeDir(next: string): void {
	setHomeDirSignal(next);
}

/** Abbreviate a server path for display (`~` for the home prefix). */
export function displayPath(path: string): string {
	const home = homeDir();
	return home ? abbreviateHome(path, home) : path;
}

/** Last path segment, e.g. `/home/me/project` → `project`. */
export function workspaceName(path: string): string {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? path;
}

/**
 * The last workspace the user viewed, persisted for the next visit. The
 * current workspace is route-derived (the `/w/<token>` param or the open
 * session's header) — this is only a convenience fallback for "New chat" on
 * the overview.
 */
const [lastWorkspace, setLastWorkspaceSignal] = createSignal(readStoredCwd() ?? "");
export { lastWorkspace };

/** Remember the workspace of the current view for the next visit. */
export function rememberWorkspace(cwd: string): void {
	const value = normalizeWorkspace(cwd);
	setLastWorkspaceSignal(value);
	writeStoredCwd(value);
}

/**
 * Expand a workspace input into an absolute path. Returns null when it cannot
 * be resolved (empty, relative, or `~` without a known home directory), so
 * callers can leave the current workspace untouched instead of storing an
 * unusable path.
 */
export function resolveWorkspaceInput(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	if (trimmed === "~" || trimmed.startsWith("~/")) {
		const home = homeDir();
		return home ? expandHome(trimmed, home) : null;
	}
	return isAbsolutePath(trimmed) ? trimmed : null;
}

/** True for absolute POSIX or Windows paths; the server rejects relative paths. */
function isAbsolutePath(path: string): boolean {
	return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

/** Trim whitespace and trailing slashes (except for the filesystem root). */
function normalizeWorkspace(path: string): string {
	const trimmed = path.trim();
	if (trimmed.length <= 1) return trimmed;
	return trimmed.replace(/\/+$/, "");
}
