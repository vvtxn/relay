/**
 * Curated Shiki entry point, aliased over `"shiki"` in `vite.config.ts`.
 *
 * `@pierre/diffs`' shared highlighter imports `createHighlighter`,
 * `createJavaScriptRegexEngine`, `createOnigurumaEngine`, and
 * `bundledLanguages` from the root `"shiki"` entry. That entry carries Shiki's
 * complete registries: every bundled grammar (~200 lazy chunks), every bundled
 * theme, and the Oniguruma WASM engine. The app only ever uses the JavaScript
 * regex engine, the `pierre-dark` / `pierre-light` themes, and a handful of
 * languages, so resolving `"shiki"` here keeps the rest out of the bundle.
 *
 * The language map below is the only set of grammars that can be highlighted;
 * anything else falls back to plain text through `highlight.ts`. Grammars are
 * still lazy: the browser only fetches a language chunk when code in that
 * language is first rendered. To support another language, add it to
 * `LANGUAGES` (and its aliases to `ALIASES`).
 */

import type { LanguageRegistration, RegexEngine } from "shiki/core";

type LanguageLoader = () => Promise<{ default: LanguageRegistration[] }>;

/** Canonical grammars bundled with the web app. */
const LANGUAGES = {
	typescript: () => import("@shikijs/langs/typescript"),
	tsx: () => import("@shikijs/langs/tsx"),
	javascript: () => import("@shikijs/langs/javascript"),
	jsx: () => import("@shikijs/langs/jsx"),
	json: () => import("@shikijs/langs/json"),
	jsonc: () => import("@shikijs/langs/jsonc"),
	json5: () => import("@shikijs/langs/json5"),
	yaml: () => import("@shikijs/langs/yaml"),
	toml: () => import("@shikijs/langs/toml"),
	ini: () => import("@shikijs/langs/ini"),
	markdown: () => import("@shikijs/langs/markdown"),
	bash: () => import("@shikijs/langs/bash"),
	powershell: () => import("@shikijs/langs/powershell"),
	python: () => import("@shikijs/langs/python"),
	rust: () => import("@shikijs/langs/rust"),
	go: () => import("@shikijs/langs/go"),
	c: () => import("@shikijs/langs/c"),
	cpp: () => import("@shikijs/langs/cpp"),
	csharp: () => import("@shikijs/langs/csharp"),
	java: () => import("@shikijs/langs/java"),
	kotlin: () => import("@shikijs/langs/kotlin"),
	swift: () => import("@shikijs/langs/swift"),
	ruby: () => import("@shikijs/langs/ruby"),
	php: () => import("@shikijs/langs/php"),
	sql: () => import("@shikijs/langs/sql"),
	html: () => import("@shikijs/langs/html"),
	css: () => import("@shikijs/langs/css"),
	scss: () => import("@shikijs/langs/scss"),
	diff: () => import("@shikijs/langs/diff"),
	docker: () => import("@shikijs/langs/docker"),
	graphql: () => import("@shikijs/langs/graphql"),
	lua: () => import("@shikijs/langs/lua"),
	r: () => import("@shikijs/langs/r"),
	zig: () => import("@shikijs/langs/zig"),
	dart: () => import("@shikijs/langs/dart"),
	elixir: () => import("@shikijs/langs/elixir"),
	scala: () => import("@shikijs/langs/scala"),
	xml: () => import("@shikijs/langs/xml"),
	hcl: () => import("@shikijs/langs/hcl"),
	make: () => import("@shikijs/langs/make"),
	vue: () => import("@shikijs/langs/vue"),
	svelte: () => import("@shikijs/langs/svelte"),
	protobuf: () => import("@shikijs/langs/protobuf"),
} satisfies Record<string, LanguageLoader>;

/** Fence aliases that resolve to a canonical grammar above. */
const ALIASES = {
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	yml: "yaml",
	md: "markdown",
	sh: "bash",
	shell: "bash",
	shellscript: "bash",
	zsh: "bash",
	ps1: "powershell",
	py: "python",
	rs: "rust",
	cxx: "cpp",
	cs: "csharp",
	kt: "kotlin",
	kts: "kotlin",
	rb: "ruby",
	gql: "graphql",
	dockerfile: "docker",
	terraform: "hcl",
	tf: "hcl",
	makefile: "make",
	proto: "protobuf",
} satisfies Record<string, keyof typeof LANGUAGES>;

/** Language loaders keyed by every name and alias a fence may use. */
export const bundledLanguages: Record<string, LanguageLoader> = { ...LANGUAGES };
for (const [alias, canonical] of Object.entries(ALIASES)) {
	bundledLanguages[alias] = LANGUAGES[canonical];
}

/**
 * Drop-in replacement for Shiki's root `createHighlighter`. `@pierre/diffs`
 * calls it with an explicit engine, matching `createHighlighterCore`. Everything
 * else (theme helpers, token utilities, types) comes straight from the core.
 */
export * from "shiki/core";
export { createHighlighterCore as createHighlighter } from "shiki/core";
export { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/**
 * The WASM engine is not bundled. `@pierre/diffs` only reaches for it when
 * asked for `preferredHighlighter: "shiki-wasm"`; the app always uses the
 * JavaScript engine (see `highlight.ts`).
 */
export function createOnigurumaEngine(): RegexEngine {
	throw new Error("The Oniguruma WASM engine is not bundled; use createJavaScriptRegexEngine");
}
