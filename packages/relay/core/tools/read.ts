import { readFile } from "node:fs/promises";
import { defineTool } from "./types.ts";

const MAX_OUTPUT = 10_000;

export const readFileTool = defineTool({
	name: "read_file",
	description:
		"Read the contents of a file. Returns the file content as text. For large files, only the first portion is returned.",
	readonly: true,
	usageHint: "Read the contents of a file. Always use this instead of `cat`/`head`/`tail`.",
	parameters: {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: "The path to the file to read.",
			},
		},
		required: ["path"],
	},
	async execute(input) {
		const { path } = input as { path: string };

		try {
			const content = await readFile(path, "utf8");
			const truncated = content.length > MAX_OUTPUT;

			return {
				content: truncated ? content.slice(0, MAX_OUTPUT) + "\n...(truncated)" : content,
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
