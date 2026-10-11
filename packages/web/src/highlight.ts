/**
 * Shared syntax-highlighting bridge.
 *
 * Markdown code blocks and diff views must agree on colors, so both go through
 * the same Shiki instance: `@pierre/diffs` exposes its shared highlighter,
 * which lazily resolves any bundled Shiki language and ships the
 * `pierre-dark` / `pierre-light` theme pair the diff components default to.
 *
 * The JavaScript regex engine matches @pierre/diffs' own default and needs no
 * WASM asset. `defaultColor: "light-dark()"` bakes both palettes into every
 * token, so switching the app theme is a pure CSS change (`color-scheme`).
 */

import { getSharedHighlighter } from "@pierre/diffs";
import type { ThemedToken } from "shiki";

/** Theme pair shared by markdown code blocks and diff views. */
export const CODE_THEMES = { light: "pierre-light", dark: "pierre-dark" } as const;

export interface HighlightedCode {
	/** Tokens per line; each token carries `content` and inline styles. */
	tokens: ThemedToken[][];
}

/**
 * Streaming re-lexes recreate markdown nodes, so identical fenced blocks are
 * highlighted repeatedly; cache results (bounded, insertion-ordered) and share
 * in-flight promises. Entries are promises so concurrent readers dedupe too.
 */
const HIGHLIGHT_CACHE_LIMIT = 100;
const highlightCache = new Map<string, Promise<HighlightedCode | null>>();

async function runHighlight(code: string, lang: string): Promise<HighlightedCode | null> {
	try {
		const highlighter = await getSharedHighlighter({
			themes: [CODE_THEMES.dark, CODE_THEMES.light],
			langs: [lang],
			preferredHighlighter: "shiki-js",
		});
		return highlighter.codeToTokens(code, {
			lang,
			themes: CODE_THEMES,
			defaultColor: "light-dark()",
		});
	} catch {
		return null;
	}
}

/**
 * Highlight `code` as `lang`, loading the grammar on demand. Unknown or
 * unsupported languages resolve to `null` so callers can fall back to plain
 * text; empty input is trivially highlighted.
 */
export function highlightCode(code: string, lang: string): Promise<HighlightedCode | null> {
	if (!code) return Promise.resolve({ tokens: [] });
	const key = `${lang}\u0000${code}`;
	const cached = highlightCache.get(key);
	if (cached) return cached;
	const pending = runHighlight(code, lang);
	highlightCache.set(key, pending);
	if (highlightCache.size > HIGHLIGHT_CACHE_LIMIT) {
		const oldest = highlightCache.keys().next().value;
		if (oldest !== undefined) highlightCache.delete(oldest);
	}
	return pending;
}
