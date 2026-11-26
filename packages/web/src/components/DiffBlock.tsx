import { createMemo, For, Show } from "solid-js";
import { diffRowToken, formatDiffGutter, prettyDiff, type DiffViewRow } from "@vvtxn/relay/core/diff-view.ts";

/**
 * Unified diff rendering for edit/write tool calls.
 *
 * Rows come from `prettyDiff` in `@vvtxn/relay/core/diff-view.ts` — the same
 * model the terminal client renders — so both clients show the same hunks,
 * line-number gutter, and per-file sections. `diffRowToken` names the theme
 * token for each row; `styles.css` maps those names to `--relay-*` variables.
 * Change prefixes are never rendered: the color carries the signal.
 */

function Row(props: { row: DiffViewRow; gutter: number }) {
	const row = props.row;
	if (row.kind === "file") {
		return (
			<div class="diff-row diff-row-file">
				<span class="diff-row-path">{row.path}</span>
				<span class="diff-row-stat">
					<span data-token="success">+{row.adds}</span>
					<span data-token="error">−{row.deletes}</span>
				</span>
			</div>
		);
	}
	if (row.kind === "hunk") {
		return (
			<div class="diff-row diff-row-hunk" data-token={diffRowToken(row)}>
				{row.header}
			</div>
		);
	}
	if (row.kind === "separator") {
		return (
			<div class="diff-row" data-token={diffRowToken(row)}>
				{row.text}
			</div>
		);
	}
	return (
		<div class="diff-row" data-token={diffRowToken(row)}>
			<span class="diff-row-gutter">{formatDiffGutter(row.lineNo, props.gutter)}</span>
			<span class="diff-row-text">{row.text}</span>
		</div>
	);
}

export function DiffBlock(props: { diff: string }) {
	const view = createMemo(() => prettyDiff(props.diff, { context: true }));
	return (
		<Show when={view().rows.length > 0}>
			<div class="diff-block">
				<For each={view().rows}>{(row) => <Row row={row} gutter={view().gutter} />}</For>
			</div>
		</Show>
	);
}
