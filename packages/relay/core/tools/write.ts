import { generateDiff } from "./diff.ts";
import { defineTool } from "./types.ts";

export const writeFileTool = defineTool({
	name: "write_file",
	description: "Write content to a file. Creates the file if it does not exist, or overwrites it if it does.",
	parameters: {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: "The path to the file to write.",
			},
			content: {
				type: "string",
				description: "The content to write to the file.",
			},
		},
		required: ["path", "content"],
	},
	async execute(input) {
		const { path, content } = input as { path: string; content: string };

		try {
			let original: string | null = null;
			try {
				original = await Deno.readTextFile(path);
			} catch {
				// File doesn't exist yet
			}

			await Deno.writeTextFile(path, content);

			const isNew = original === null;
			const lines = content.split("\n").length;
			const diff = generateDiff(original ?? "", content);

			const message = isNew ? `Created ${path} (${lines} lines)` : `Wrote ${lines} lines to ${path}`;
			return { content: message, ...(diff ? { meta: { diff } } : {}) };
		} catch (err) {
			return {
				content: `Failed to write file: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
});
