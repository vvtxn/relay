import { createSignal, For, type JSX, Show } from "solid-js";
import { diffStats, getToolDisplayName, type UIToolCall } from "@vvtxn/relay/core/display.ts";
import { openDiffPreview } from "#/state/diff-preview.ts";
import { DiffBlock } from "./DiffBlock.tsx";

/**
 * Tool activity for one agent turn: a row per call on the shared `surface`
 * panel (the only chat element with a background). Rows stay collapsed to a
 * single line — glyph + name + argument + a one-word/short result stat — and
 * expand on click for the full output or diff. Clicking is deliberate, so
 * expanded content renders in full instead of being truncated again.
 */

/** `path:line:content`, as emitted by rg/grep with line numbers. */
const GREP_MATCH = /^(.*?):(\d+):(.*)$/;

export function ToolCalls(props: { toolCalls: UIToolCall[] }) {
	return (
		<div class="tool-panel">
			<For each={props.toolCalls}>{(tool) => <ToolCall tool={tool} />}</For>
		</div>
	);
}

/** A call without a result yet (its output/diff/error arrives later). */
function isPending(tool: UIToolCall): boolean {
	return tool.output.length === 0 && tool.diff === undefined && tool.isError !== true;
}

function countLabel(count: number, singular: string, plural: string): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

function ToolCall(props: { tool: UIToolCall }) {
	const tool = () => props.tool;
	const pending = () => isPending(tool());
	const hasDetails = () => tool().diff !== undefined || (!pending() && tool().output.length > 0);
	const [expanded, setExpanded] = createSignal(false);

	// A diff replaces the textual result message; show whichever exists.
	const textOutput = () => (tool().diff === undefined && !pending() && tool().output.length > 0 ? tool().output : "");

	const toggle = () => {
		if (hasDetails()) setExpanded((value) => !value);
	};

	return (
		<div
			class="tool-call"
			data-tool={tool().name}
			data-error={tool().isError === true ? "" : undefined}
			data-details={hasDetails() ? "" : undefined}
			data-expanded={expanded() ? "" : undefined}
		>
			<div class="tool-call-row">
				<button
					type="button"
					class="tool-call-head"
					aria-expanded={expanded()}
					disabled={!hasDetails()}
					onClick={toggle}
				>
					<span class="tool-call-name">{getToolDisplayName(tool().name)}</span>
					<span class="tool-call-arg" title={tool().input}>
						{tool().input}
					</span>
					<Show when={pending()}>
						<span class="tool-call-status">running…</span>
					</Show>
					<ResultBadge tool={tool()} />
					<Show when={hasDetails()}>
						<span class="tool-call-chevron" aria-hidden="true">
							›
						</span>
					</Show>
				</button>
				<Show when={tool().diff}>
					{(diff) => (
						<button
							type="button"
							class="tool-call-diff"
							aria-label={`View diff for ${tool().input}`}
							onClick={() => openDiffPreview({ name: tool().name, path: tool().input, diff: diff() })}
						>
							View diff
						</button>
					)}
				</Show>
			</div>
			<Show when={expanded()}>
				<div class="tool-call-details">
					<Show when={tool().diff}>{(diff) => <DiffBlock diff={diff()} />}</Show>
					<Show when={textOutput()}>{(output) => <ToolOutput tool={tool()} output={output()} />}</Show>
				</div>
			</Show>
		</div>
	);
}

/** The short result stat shown on the collapsed row. */
function ResultBadge(props: { tool: UIToolCall }): JSX.Element {
	const badge = (): JSX.Element => {
		const tool = props.tool;
		if (isPending(tool)) return null;
		if (tool.isError) return <span class="tool-call-badge">error</span>;

		switch (tool.name) {
			case "grep": {
				if (tool.output === "No matches found.") return <span class="tool-call-badge">no matches</span>;
				const matches = tool.output.split("\n").filter((line) => GREP_MATCH.test(line));
				const files = new Set(
					matches.map((line) => GREP_MATCH.exec(line)?.[1]).filter((file) => file !== undefined),
				);
				return (
					<span class="tool-call-badge">
						{countLabel(matches.length, "match", "matches")} in {countLabel(files.size, "file", "files")}
					</span>
				);
			}
			case "read_file":
				return (
					<span class="tool-call-badge">{countLabel(tool.output.split("\n").length, "line", "lines")}</span>
				);
			case "write_file":
			case "edit_file": {
				if (!tool.diff) return null;
				const stats = diffStats(tool.diff);
				return (
					<span class="tool-call-badge">
						<span class="badge-add">+{stats.adds}</span> <span class="badge-del">−{stats.deletes}</span>
					</span>
				);
			}
			default:
				return null;
		}
	};
	return <Show when={badge()}>{(value) => value()}</Show>;
}

function ToolOutput(props: { tool: UIToolCall; output: string }) {
	if (props.tool.name === "grep") {
		const matches = props.output
			.split("\n")
			.filter(Boolean)
			.map((line) => GREP_MATCH.exec(line))
			.filter((match) => match !== null);
		if (matches.length > 0) return <GrepOutput matches={matches} />;
	}
	return (
		<div class="tool-output" data-error={props.tool.isError === true ? "" : undefined}>
			<pre>{props.output}</pre>
		</div>
	);
}

function GrepOutput(props: { matches: RegExpExecArray[] }) {
	return (
		<div class="tool-output grep-output">
			<For each={props.matches}>
				{(match) => (
					<div class="grep-match">
						<span class="grep-file">{match[1]}</span>
						<span class="grep-line-number">:{match[2]}</span>
						<span class="grep-text">{match[3]}</span>
					</div>
				)}
			</For>
		</div>
	);
}
