// Tests for buildSystemPrompt: registry-aware tool guidance, mode composition,
// and the shared default prompt.

import { describe, expect, it } from "vite-plus/test";
import { buildSystemPrompt } from "../core/prompts.ts";
import { SYSTEM_PROMPT } from "../core/system-prompt.ts";
import { defaultTools } from "../core/tools/index.ts";
import { createToolRegistry, defineTool } from "../core/tools/types.ts";

const BUILT_IN = ["bash", "read_file", "write_file", "edit_file", "grep"];

describe("buildSystemPrompt", () => {
	it("renders tool guidance from the registry", () => {
		const prompt = buildSystemPrompt({ mode: "main", tools: defaultTools });

		for (const name of BUILT_IN) {
			expect(prompt).toContain(`**${name}**`);
		}
		// The Agency section names the read-only tools from the same registry.
		expect(prompt).toContain("Read-only tools (read_file, grep)");
	});

	it("never mentions tools that are not in the registry", () => {
		const withoutBash = defaultTools.filter((tool) => tool.definition.function.name !== "bash");
		const prompt = buildSystemPrompt({ mode: "main", tools: withoutBash });

		expect(prompt).not.toContain("**bash**");
		expect(prompt).not.toContain("`pnpm run`");
	});

	it("covers custom tools via usageHint or the description's first sentence", () => {
		const deploy = defineTool({
			name: "deploy",
			description: "Deploy the app to production. Details follow after this sentence.",
			usageHint: "Ship it.",
			parameters: { type: "object" },
			execute: async () => ({ content: "ok" }),
		});
		const ping = defineTool({
			name: "ping",
			description: "Ping a host. Details follow after this sentence.",
			parameters: { type: "object" },
			execute: async () => ({ content: "ok" }),
		});

		const prompt = buildSystemPrompt({ mode: "main", tools: [deploy, ping] });

		expect(prompt).toContain("- **deploy** — Ship it.");
		expect(prompt).toContain("- **ping** — Ping a host.");
		expect(prompt).not.toContain("Details follow");
	});

	it("renders a focused subagent prompt instead of the main-agent sections", () => {
		const prompt = buildSystemPrompt({ mode: "subagent", tools: createToolRegistry(defaultTools) });

		expect(prompt).toContain("subagent");
		expect(prompt).toContain("read-only access");
		expect(prompt).toContain("## Report");
		// Tool guidance still comes from the registry.
		expect(prompt).toContain("**read_file**");
		// Main-agent-only sections are absent.
		expect(prompt).not.toContain("Not surprising the user");
		expect(prompt).not.toContain("## Code Quality");
		expect(prompt).not.toContain("## Self-Review");
	});

	it("appends extra instructions verbatim", () => {
		const prompt = buildSystemPrompt({ tools: [], extraInstructions: "Always answer in French." });

		expect(prompt.trimEnd().endsWith("Always answer in French.")).toBe(true);
	});

	it("omits the tool section when no tools are given", () => {
		const prompt = buildSystemPrompt({});

		expect(prompt).not.toContain("## Tool Usage");
		expect(prompt).toContain("## Agency");
	});

	it("defaults to the built-in toolset and excludes runtime-only tools", () => {
		for (const name of BUILT_IN) {
			expect(SYSTEM_PROMPT).toContain(`**${name}**`);
		}
		// `delegate` is wired by the server per run, not part of defaultTools.
		expect(SYSTEM_PROMPT).not.toContain("**delegate**");
	});
});
