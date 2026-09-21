import { createSignal } from "solid-js";
import { expandHome } from "@vvtxn/relay/core/display.ts";
import { readStoredCwd, writeStoredCwd } from "@/api/storage.ts";

const [cwd, setCwdSignal] = createSignal(readStoredCwd() ?? "");
export { cwd };

const [homeDir, setHomeDirSignal] = createSignal("");
export { homeDir };

/** Record the server's home directory for path abbreviation/expansion. */
export function setHomeDir(next: string): void {
	setHomeDirSignal(next);
}

/**
 * Expand a workspace input into an absolute path. Returns null when it cannot
 * be resolved (empty, or `~` without a known home directory), so callers can
 * leave the current workspace untouched instead of storing a literal `~` path.
 */
export function resolveWorkspaceInput(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	if (trimmed === "~" || trimmed.startsWith("~/")) {
		const home = homeDir();
		return home ? expandHome(trimmed, home) : null;
	}
	return trimmed;
}

/** Update the active workspace and persist it for the next visit. */
export function setCwd(next: string): void {
	const value = normalizeWorkspace(next);
	if (!value || value === cwd()) return;
	setCwdSignal(value);
	writeStoredCwd(value);
}

/** Trim whitespace and trailing slashes (except for the filesystem root). */
function normalizeWorkspace(path: string): string {
	const trimmed = path.trim();
	if (trimmed.length <= 1) return trimmed;
	return trimmed.replace(/\/+$/, "");
}
