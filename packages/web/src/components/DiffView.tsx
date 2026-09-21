import { For } from "solid-js";
import { parseDiffLines } from "@vvtxn/relay/core/display.ts";

export function DiffView(props: { diff: string }) {
	const lines = () => parseDiffLines(props.diff);
	const pad = () => String(lines().reduce((max, line) => Math.max(max, line.lineNo), 0)).length;

	return (
		<div class="diff">
			<For each={lines()}>
				{(line) => (
					<div class={`diff-line ${line.prefix === "+" ? "add" : line.prefix === "-" ? "del" : "ctx"}`}>
						<span class="diff-no">{String(line.lineNo).padStart(pad())}</span>
						<span class="diff-prefix">{line.prefix}</span>
						<span class="diff-content">{line.content}</span>
					</div>
				)}
			</For>
		</div>
	);
}
