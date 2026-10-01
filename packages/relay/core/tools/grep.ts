import { defineTool } from "./types.ts";

const MAX_OUTPUT = 10_000;

export const grepTool = defineTool({
	name: "grep",
	description:
		"Search for a text pattern in files using ripgrep (rg). Returns matching lines with file paths and line numbers. " +
		"Supports regex patterns by default. Use the glob parameter to filter by file type (e.g. '*.ts'). " +
		"Falls back to grep if ripgrep is not installed.",
	readonly: true,
	parameters: {
		type: "object",
		properties: {
			pattern: {
				type: "string",
				description: "The search pattern (regex by default). Use fixed_strings: true for literal text search.",
			},
			path: {
				type: "string",
				description: "The directory or file to search in. Defaults to current directory.",
			},
			glob: {
				type: "string",
				description: "File glob pattern to filter searched files (e.g. '*.ts', '*.{js,jsx}'). Ripgrep only.",
			},
			fixed_strings: {
				type: "boolean",
				description: "Treat pattern as a literal string instead of a regex.",
			},
			case_sensitive: {
				type: "boolean",
				description: "Force case-sensitive (true) or case-insensitive (false) search. Default: smart-case.",
			},
			max_results: {
				type: "number",
				description: "Maximum number of matching lines to return. Defaults to no limit.",
			},
		},
		required: ["pattern"],
	},
	async execute(input) {
		const { pattern, path, glob, fixed_strings, case_sensitive, max_results } = input as {
			pattern: string;
			path?: string;
			glob?: string;
			fixed_strings?: boolean;
			case_sensitive?: boolean;
			max_results?: number;
		};
		const searchPath = path ?? ".";

		try {
			let result: Deno.CommandOutput;
			try {
				const args = buildRgArgs({ pattern, searchPath, glob, fixed_strings, case_sensitive, max_results });
				result = await new Deno.Command("rg", { args, stdout: "piped", stderr: "piped" }).output();
			} catch {
				// Ripgrep not available — fall back to grep
				const args = ["-rn", "--color=never"];
				if (fixed_strings) args.push("-F");
				if (case_sensitive === false) args.push("-i");
				if (max_results !== undefined) args.push(`-m${max_results}`);
				args.push(pattern, searchPath);
				result = await new Deno.Command("grep", { args, stdout: "piped", stderr: "piped" }).output();
			}

			const stdout = new TextDecoder().decode(result.stdout);
			const stderr = new TextDecoder().decode(result.stderr);

			if (!stdout && result.code === 1) {
				return { content: "No matches found." };
			}

			if (!result.success && result.code !== 1) {
				return { content: `Search failed: ${stderr || `exit code ${result.code}`}`, isError: true };
			}

			const truncated = stdout.length > MAX_OUTPUT;
			return {
				content: truncated ? stdout.slice(0, MAX_OUTPUT) + "\n...(truncated)" : stdout,
				meta: { truncated },
			};
		} catch (err) {
			return {
				content: `Failed to search: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
});

function buildRgArgs(opts: {
	pattern: string;
	searchPath: string;
	glob?: string | undefined;
	fixed_strings?: boolean | undefined;
	case_sensitive?: boolean | undefined;
	max_results?: number | undefined;
}): string[] {
	const args = ["--line-number", "--no-heading", "--color=never"];
	if (opts.fixed_strings) args.push("--fixed-strings");
	if (opts.case_sensitive === true) args.push("--case-sensitive");
	if (opts.case_sensitive === false) args.push("--ignore-case");
	if (opts.glob) args.push("--glob", opts.glob);
	if (opts.max_results !== undefined) args.push("--max-count", String(opts.max_results));
	args.push(opts.pattern, opts.searchPath);
	return args;
}
