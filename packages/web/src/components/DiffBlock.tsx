import { createMemo, For, Show } from "solid-js";
import { buildDiffRows, type DiffRow } from "@vvtxn/relay/core/display.ts";

/**
 * Unified diff rendering for edit/write tool calls.
 *
 * The rows come from `buildDiffRows` in `@vvtxn/relay/core/display.ts` — the
 * same pure model the terminal client renders, so both clients show the same
 * hunks, line-number gutter, and add/remove coloring. Rows are colored from the
 * shared `--relay-*` theme tokens; no highlighting library is involved.
 */

function kindOf(prefix: "+" | "-" | " "): "add" | "del" | "ctx" {
	if (prefix === "+") return "add";
	if (prefix === "-") return "del";
	return "ctx";
}

function Row(props: { row: DiffRow; gutter: number }) {
	const row = props.row;
	if (row.kind !== "line") return <div class="diff-row diff-row-hunk">{row.text}</div>;
	return (
		<div class="diff-row" data-kind={kindOf(row.prefix)}>
			<span class="diff-row-gutter">{String(row.lineNo).padStart(props.gutter)}</span>
			<span class="diff-row-text">
				{row.prefix}
				{row.content}
			</span>
		</div>
	);
}

export function DiffBlock(props: { diff: string }) {
	const view = createMemo(() => buildDiffRows(props.diff, { context: true }));
	return (
		<Show when={view().rows.length > 0}>
			<div class="diff-block">
				<For each={view().rows}>{(row) => <Row row={row} gutter={view().gutter} />}</For>
			</div>
		</Show>
	);
}
