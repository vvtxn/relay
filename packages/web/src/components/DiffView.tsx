import { parseDiffLines } from "@vvtxn/relay/core/display.ts";

export function DiffView({ diff }: { diff: string }) {
	const lines = parseDiffLines(diff);
	const pad = String(lines.reduce((max, l) => Math.max(max, l.lineNo), 0)).length;

	return (
		<div class="diff">
			{lines.map((l, i) => (
				<div key={i} class={`diff-line ${l.prefix === "+" ? "add" : l.prefix === "-" ? "del" : "ctx"}`}>
					<span class="diff-no">{String(l.lineNo).padStart(pad)}</span>
					<span class="diff-prefix">{l.prefix}</span>
					<span class="diff-content">{l.content || " "}</span>
				</div>
			))}
		</div>
	);
}
