/**
 * System prompt composition.
 *
 * The prompt is assembled from named sections as code, so the tool-usage
 * guidance is rendered from the registry the runtime will actually expose —
 * adding, removing, or renaming a tool can never leave the prompt stale.
 * `system-prompt.ts` builds the shared default from `defaultTools`.
 */

import type { Tool, ToolRegistry } from "./tools/types.ts";

/** Which agent the prompt is for: the user-facing coding agent or a subagent. */
export type SystemPromptMode = "main" | "subagent";

export interface BuildSystemPromptOptions {
	/** `main` (default) is the coding agent; `subagent` is a delegated investigator. */
	mode?: SystemPromptMode;
	/** The tools the runtime will expose; renders the registry-aware Tool Usage section. */
	tools?: ToolRegistry | readonly Tool[];
	/** Appended verbatim at the end (e.g. project-specific instructions). */
	extraInstructions?: string;
}

/**
 * Builds the system prompt for one agent run.
 *
 * Tool guidance is generated from `tools`: each tool contributes a bullet from
 * its `usageHint` (falling back to the first sentence of its description), and
 * the Agency section names the read-only tools. Unknown or custom tools are
 * covered automatically; tools that are not in the registry are never mentioned.
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const tools = toolList(options.tools);
	const sections =
		options.mode === "subagent"
			? [SUBAGENT_IDENTITY, SUBAGENT_AGENCY, toolUsageSection(tools), SUBAGENT_REPORT]
			: [
					MAIN_IDENTITY,
					agencySection(tools),
					toolUsageSection(tools),
					WORKFLOW_EXISTING_PROJECTS,
					WORKFLOW_NEW_PROJECTS,
					WORKFLOW_GENERAL,
					CODE_QUALITY,
					selfReviewSection(tools),
					MAIN_COMMUNICATION,
				];

	const extra = options.extraInstructions?.trim();
	if (extra) sections.push(extra);
	return `${sections.filter(Boolean).join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const MAIN_IDENTITY = `You are a coding assistant. You help the user with software engineering tasks. Use the
instructions below and the tools available to you to help the user.`;

const SUBAGENT_IDENTITY = `You are a subagent: the main coding assistant delegated one focused investigation to you.
You have read-only access to the workspace and cannot modify files. Work autonomously — nobody can answer questions
mid-task.`;

const SUBAGENT_AGENCY = `## Agency

Use the tools to investigate efficiently. When you need several independent lookups, request them in parallel;
read-only tools are always safe to run concurrently.`;

const WORKFLOW_EXISTING_PROJECTS = `## Workflow

### Existing Projects

When working in a directory with existing files:

- Read the code before modifying it. Never propose changes to code you haven't read
- Check for AGENTS.md in the project root and relevant subdirectories for project-specific conventions
- Look at surrounding context (imports, neighboring files) to understand frameworks and conventions in use
- Follow existing patterns: naming, typing, code style, library choices`;

const WORKFLOW_NEW_PROJECTS = `### New / Empty Projects

When working in an empty or new directory:

- Start creating files directly based on the user's request — do not search for existing structure
- Ask for clarification only if the request is genuinely ambiguous (language, framework, etc.)
- Create a sensible project structure appropriate for the language and task`;

const WORKFLOW_GENERAL = `### General

- Work incrementally: make a small change, verify it works, then continue
- Never assume a library is available. Check package.json, cargo.toml, go.mod, etc. before using one
- When creating new components or modules, look at existing ones first to match conventions`;

const CODE_QUALITY = `## Code Quality

- Keep functions short and focused
- Prefer const over let; use early returns over deep nesting
- Do not add comments unless the user asks or the code is genuinely complex
- Do not suppress compiler or linter errors (e.g., \`as any\`, \`// @ts-ignore\`) unless the user explicitly asks
- Follow security best practices. Never introduce code that exposes or logs secrets`;

const MAIN_COMMUNICATION = `## Communication

Be concise and direct. Do not repeat tool output back to the user — they can see it. Focus on what matters: what you
did, what you found, or what needs attention.`;

const SUBAGENT_REPORT = `## Report

When the investigation is done, reply with a concise report for the caller: the relevant file paths and line
references, what you concluded, and any open questions. Do not repeat tool output back — focus on findings.`;

function agencySection(tools: readonly Tool[]): string {
	const readonlyNames = tools.filter((tool) => tool.readonly).map(toolName);
	const parallelism =
		readonlyNames.length > 0
			? `Read-only tools (${readonlyNames.join(", ")}) are always safe to run in parallel, and edits to ` +
				"different files can be requested in the same turn — the runtime executes them concurrently. Do not make " +
				"multiple edits to the same file in the same turn; they may conflict."
			: "Edits to different files can be requested in the same turn — the runtime executes them concurrently. Do " +
				"not make multiple edits to the same file in the same turn; they may conflict.";
	return `## Agency

Use tools to accomplish tasks efficiently. Prefer automation: execute requested actions without confirmation unless
blocked by missing info or safety concerns.

You take initiative when the user asks you to do something, but maintain balance between:

1. Doing the right thing — taking actions and follow-up actions until the task is complete
2. Not surprising the user — if they ask how to approach something, answer first before acting

When you know you need to run multiple tools, run them in parallel if they are independent operations. ${parallelism}`;
}

function toolUsageSection(tools: readonly Tool[]): string {
	if (tools.length === 0) return "";
	const lines = tools.map((tool) => {
		const hint = tool.usageHint?.trim() || firstSentence(tool.definition.function.description);
		const name = toolName(tool);
		return hint ? `- **${name}** — ${hint}` : `- **${name}**`;
	});
	return `## Tool Usage\n\n${lines.join("\n")}`;
}

function selfReviewSection(tools: readonly Tool[]): string {
	const reader = tools.some((tool) => toolName(tool) === "read_file") ? " using read_file" : "";
	return `## Self-Review

After the overall task is complete, briefly review your changes${reader}. Check for bugs, typos, or logic errors.
Fix any issues found before reporting the task as done. Do not verify individual steps mid-task — only verify once at
the end. Do not run extra shell commands to verify unless the task specifically requires running tests or builds.`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolList(source: ToolRegistry | readonly Tool[] | undefined): readonly Tool[] {
	if (!source) return [];
	return source instanceof Map ? [...source.values()] : source;
}

function toolName(tool: Tool): string {
	return tool.definition.function.name;
}

/** First sentence of a description, trimmed for prompt rendering. */
function firstSentence(text: string): string {
	const match = /^[^.]*\./.exec(text.trim());
	const sentence = (match ? match[0] : text.trim()).trim();
	return sentence.length > 200 ? `${sentence.slice(0, 200)}...` : sentence;
}
