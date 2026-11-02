import { For } from "solid-js";

/**
 * Renders plain user text with `@path` file mentions highlighted in the shared
 * `mention` accent, matching the CLI's composer styling. Mentions are the
 * `@`-prefixed tokens the server expands into an `<attached_context>` block, so
 * coloring them makes the embedded file annotations stand out from prose.
 */

const MENTION_RE = /(^|\s)(@[^\s]+)/g;

interface Part {
	text: string;
	mention: boolean;
}

function splitMentions(text: string): Part[] {
	const parts: Part[] = [];
	let last = 0;
	for (const match of text.matchAll(MENTION_RE)) {
		const start = match.index + (match[1]?.length ?? 0);
		if (start > last) parts.push({ text: text.slice(last, start), mention: false });
		parts.push({ text: match[2] ?? "", mention: true });
		last = start + (match[2]?.length ?? 0);
	}
	if (last < text.length) parts.push({ text: text.slice(last), mention: false });
	return parts;
}

export function MentionText(props: { text: string }) {
	return (
		<For each={splitMentions(props.text)}>
			{(part) => (part.mention ? <span class="mention">{part.text}</span> : part.text)}
		</For>
	);
}
