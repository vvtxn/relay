import { Show } from "solid-js";

/** The fence info string may carry extras (`ts title="x"`); keep the language. */
function normalizeLang(info: string | undefined): string {
	const first = info?.trim().split(/\s+/)[0]?.toLowerCase();
	return first ? first : "text";
}

/**
 * A fenced code block in the shared mono style. The app ships no syntax
 * highlighter (code is shown as plain text, labeled with its language).
 */
export function CodeBlock(props: { code: string; lang?: string | undefined }) {
	return (
		<div class="code-shell">
			<Show when={normalizeLang(props.lang) !== "text"}>
				<span class="code-lang">{normalizeLang(props.lang)}</span>
			</Show>
			<pre class="code-block">
				<code>{props.code}</code>
			</pre>
		</div>
	);
}
