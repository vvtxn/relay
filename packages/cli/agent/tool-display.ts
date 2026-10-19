/** Shared display metadata for tool-call rows and the diff review overlay. */

import { theme } from "#/tui/theme.ts";

/** Per-tool accents — the same tokens the web client colors tool names with. */
export const TOOL_COLORS: Record<string, string> = {
	read_file: theme.toolRead,
	write_file: theme.toolWrite,
	edit_file: theme.toolEdit,
	grep: theme.toolGrep,
	bash: theme.toolRun,
};

/** Widest tool display name (`delegate`), so rows stay aligned. */
export const TOOL_NAME_WIDTH = 8;
