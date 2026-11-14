/**
 * System prompt composition.
 *
 * Deliberately small: the model gets a few operating rules plus optional
 * workspace and safety context. Tool mechanics belong in each tool's schema
 * description, not in the prompt.
 */

/** Which agent the prompt is for: the user-facing coding agent or a subagent. */
export type SystemPromptMode = "main" | "subagent";

export interface BuildSystemPromptOptions {
	/** `main` (default) is the coding agent; `subagent` is a delegated investigator. */
	mode?: SystemPromptMode;
	/** Current box profile, when the run executes inside an isolated box. */
	box?: {
		profile: string;
		cpus: number;
		memoryMiB: number;
		maxProfile: string;
		/** True when the prepared image has Playwright + Chromium embedded. */
		playwright: boolean;
	};
	/** True when the run executes directly on the host with no box. */
	host?: boolean;
	/** Appended verbatim at the end (e.g. project-specific instructions). */
	extraInstructions?: string;
}

/** Builds the system prompt for one agent run. */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const sections =
		options.mode === "subagent"
			? [SUBAGENT_IDENTITY]
			: [
					MAIN_IDENTITY,
					MAIN_RULES,
					workspaceSection(options.box, options.host),
					safetySection(options.box, options.host),
				];

	const extra = options.extraInstructions?.trim();
	if (extra) sections.push(extra);
	return `${sections.filter(Boolean).join("\n\n")}\n`;
}

const MAIN_IDENTITY = `You are a coding agent working in the user's workspace. Help with software engineering tasks using
the tools available to you.`;

const MAIN_RULES = `## Rules

- Start from the user's request and a concrete hypothesis. Investigate only enough to understand the relevant code,
  then act. Stop searching once you can make the change or answer.
- For investigation-only requests, report the cause and the evidence once you have them; do not keep reading
  unrelated code.
- Batch independent tool calls in one turn. Read a file before editing it.
- Use the dedicated file tools for reading, searching, writing, and editing instead of shell equivalents.
- Keep responses concise; do not narrate routine tool calls.`;

const SUBAGENT_IDENTITY = `You are a read-only investigator. Work autonomously — nobody can answer questions mid-task.
Use tools efficiently, and return a concise report with file paths, findings, and any uncertainties.`;

function workspaceSection(box: BuildSystemPromptOptions["box"], host: boolean | undefined): string {
	if (box) {
		return `## Workspace

You are working in a durable clone of the user's project. File tools edit the clone; bash and browser run in an
isolated box, so the user's checkout is untouched. Commit and push from the workspace when the task calls for it.
For UI changes, verify the rendered result with the browser before reporting done.`;
	}
	if (host) {
		return `## Workspace

You are working directly on the host with no sandbox.`;
	}
	return "";
}

function safetySection(box: BuildSystemPromptOptions["box"], host: boolean | undefined): string {
	if (box) {
		return `## Safety

Ask before actions that leave the box or are hard to undo: pushing, deploying, deleting data outside the workspace,
or using real credentials.`;
	}
	if (host) {
		return `## Safety

Treat commands as potentially destructive. Ask before destructive or irreversible actions: sudo, force-pushes,
deleting data outside the workspace, or using real credentials.`;
	}
	return "";
}
