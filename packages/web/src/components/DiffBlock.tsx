import { createEffect, createMemo, For, onCleanup, Show } from "solid-js";
import { FileDiff, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { parseDiffLines } from "@vvtxn/relay/core/display.ts";
import { CODE_THEMES } from "#/highlight.ts";
import { theme } from "#/state/theme.ts";

/**
 * Unified diff rendering for edit/write tool calls.
 *
 * `@pierre/diffs` (Shiki-based) renders each file in the patch with line
 * numbers, inline change highlighting, and collapsible context. It shares the
 * app's Shiki highlighter with markdown code blocks (see `highlight.ts`), and
 * tracks the app palette via `themeType`. Unparseable diffs fall back to plain
 * line coloring from `parseDiffLines`.
 */

/** Parse a patch; tolerate nothing — fall back to plain lines on any error. */
function parseFiles(raw: string): FileDiffMetadata[] {
	try {
		return parsePatchFiles(raw, undefined, true).flatMap((patch) => patch.files);
	} catch {
		return [];
	}
}

function DiffFile(props: { file: FileDiffMetadata }) {
	let host: HTMLDivElement | undefined;

	createEffect(() => {
		if (!host) return;
		const instance = new FileDiff({
			theme: { dark: CODE_THEMES.dark, light: CODE_THEMES.light },
			themeType: theme(),
			diffStyle: "unified",
			overflow: "wrap",
			disableFileHeader: true,
		});
		instance.render({ fileDiff: props.file, containerWrapper: host });
		onCleanup(() => instance.cleanUp());
	});

	return <div class="diff-file" ref={host} />;
}

/** Fallback for diffs Pierre cannot parse: still color added/removed lines. */
function PlainDiff(props: { diff: string }) {
	const lines = createMemo(() => parseDiffLines(props.diff));
	return (
		<pre class="diff-plain">
			<For each={lines()}>
				{(line) => (
					<span
						class="diff-plain-line"
						data-kind={line.prefix === "+" ? "add" : line.prefix === "-" ? "del" : "ctx"}
					>
						{line.prefix}
						{line.content}
						{"\n"}
					</span>
				)}
			</For>
		</pre>
	);
}

export function DiffBlock(props: { diff: string }) {
	const files = createMemo(() => parseFiles(props.diff));
	return (
		<Show when={files().length > 0} fallback={<PlainDiff diff={props.diff} />}>
			<For each={files()}>{(file) => <DiffFile file={file} />}</For>
		</Show>
	);
}
