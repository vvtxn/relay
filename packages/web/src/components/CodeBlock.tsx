import { createEffect, createSignal, For, Show } from "solid-js";
import type { ThemedToken } from "shiki";
import { highlightCode, type HighlightedCode } from "#/highlight.ts";

/** Serialize a token's inline styles (Shiki colors, italics, …) for `style=`. */
function tokenStyle(token: ThemedToken): string | undefined {
	const styles = token.htmlStyle;
	if (!styles) return undefined;
	const entries = Object.entries(styles);
	if (entries.length === 0) return undefined;
	return entries.map(([key, value]) => `${key}:${value}`).join(";");
}

/** The fence info string may carry extras (`ts title="x"`); keep the language. */
function normalizeLang(info: string | undefined): string {
	const first = info?.trim().split(/\s+/)[0]?.toLowerCase();
	return first ? first : "text";
}

/**
 * A fenced code block highlighted with the shared Shiki highlighter. The plain
 * text renders immediately; tokens replace it when the grammar has loaded.
 * Unknown languages stay plain text instead of failing.
 */
export function CodeBlock(props: { code: string; lang?: string | undefined }) {
	const lang = () => normalizeLang(props.lang);
	const [highlighted, setHighlighted] = createSignal<HighlightedCode | null>(null);
	let generation = 0;

	createEffect(() => {
		const code = props.code;
		const language = lang();
		const current = ++generation;
		setHighlighted(null);
		void highlightCode(code, language).then((result) => {
			// Ignore results that arrive after newer code superseded them.
			if (current === generation) setHighlighted(result);
		});
	});

	return (
		<div class="code-shell">
			<Show when={lang() !== "text"}>
				<span class="code-lang">{lang()}</span>
			</Show>
			<pre class="code-block">
				<code>
					<Show when={highlighted()} fallback={props.code}>
						{(result) => (
							<For each={result().tokens}>
								{(line, lineIndex) => (
									<span class="code-line">
										<For each={line}>
											{(token) => <span style={tokenStyle(token)}>{token.content}</span>}
										</For>
										<Show when={lineIndex() < result().tokens.length - 1}>{"\n"}</Show>
									</span>
								)}
							</For>
						)}
					</Show>
				</code>
			</pre>
		</div>
	);
}
