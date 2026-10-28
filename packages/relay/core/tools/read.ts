import { readFile } from "node:fs/promises";
import { defineTool } from "./types.ts";

const MAX_OUTPUT = 10_000;

export const readFileTool = defineTool({
	name: "read_file",
	description:
		"Read the contents of a file. Returns the file content as text. For large files, pass offset and limit to read a line range.",
	readonly: true,
	usageHint:
		"Read the contents of a file. Always use this instead of `cat`/`head`/`tail`. For large files, use `offset` and " +
		"`limit` to read the relevant range instead of re-reading the same truncated beginning.",
	parameters: {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: "The path to the file to read.",
			},
			offset: {
				type: "number",
				description: "1-based line number to start reading from. Defaults to the beginning.",
			},
			limit: {
				type: "number",
				description: "Maximum number of lines to read. Useful together with offset for large files.",
			},
		},
		required: ["path"],
	},
	async execute(input) {
		const { path, offset, limit } = input as { path: string; offset?: number; limit?: number };

		try {
			const content = await readFile(path, "utf8");
			const lines = content.split("\n");
			const start = typeof offset === "number" && offset > 1 ? Math.floor(offset) - 1 : 0;
			const count = typeof limit === "number" && limit > 0 ? Math.floor(limit) : undefined;
			const end = count === undefined ? undefined : start + count;
			const selected = lines.slice(start, end).join("\n");
			const truncated = selected.length > MAX_OUTPUT;
			const body = truncated ? selected.slice(0, MAX_OUTPUT) : selected;

			return {
				content: truncated ? `${body}\n...(truncated)` : body,
				meta: { truncated },
			};
		} catch (err) {
			return {
				content: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
});
