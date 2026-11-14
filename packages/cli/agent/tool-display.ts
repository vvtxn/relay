/** Shared display metadata for tool-call rows and the diff review overlay. */

import { theme } from "#/tui/theme.ts";

/**
 * Per-tool accents — the same tokens the web client colors tool names with.
 * Getters read the active palette at render time so the startup theme swap is
 * reflected even if this module was imported first.
 */
export const TOOL_COLORS: Record<string, string> = {
	get read_file() {
		return theme.toolRead;
	},
	get write_file() {
		return theme.toolWrite;
	},
	get edit_file() {
		return theme.toolEdit;
	},
	get grep() {
		return theme.toolGrep;
	},
	get bash() {
		return theme.toolRun;
	},
};

/** Widest tool display name (`delegate`), so rows stay aligned. */
export const TOOL_NAME_WIDTH = 8;
