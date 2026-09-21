/**
 * URL sanitization for rendered markdown.
 *
 * Agent output is untrusted (it can be influenced by file contents or prompt
 * injection), so links and images must only carry safe schemes. Relative and
 * same-origin references are allowed; everything else is dropped.
 */

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** Strip characters browsers ignore inside URLs (control chars) before checking. */
// deno-lint-ignore no-control-regex -- intentionally matching control characters
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Scheme prefix, e.g. `javascript:` in `javascript:alert(1)`. */
const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

export function safeUrl(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const value = raw.replace(CONTROL_CHARS, "").trim();
	if (!value) return null;

	// Same-origin relative forms: "#frag", "?query", "/path", "./x", "../x".
	if (/^[#/?]/.test(value) || /^\.{1,2}\//.test(value)) return value;

	const scheme = SCHEME_PATTERN.exec(value)?.[1]?.toLowerCase();
	if (!scheme) return value; // no scheme → relative reference
	return SAFE_SCHEMES.has(`${scheme}:`) ? value : null;
}
