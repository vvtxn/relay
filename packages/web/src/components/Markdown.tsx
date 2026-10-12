import { createDeferred, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import MarkdownIt, { type Token } from "markdown-it";
import { CodeBlock } from "./CodeBlock.tsx";
import { safeUrl } from "./safe-url.ts";

/**
 * Safe markdown renderer.
 *
 * LLM output is untrusted, so `markdown-it` only lexes (HTML disabled) and the
 * token stream is walked into Solid elements directly — raw HTML is rendered
 * as text, never injected. Fenced code blocks go through the shared Shiki
 * highlighter; links open in a new tab with `rel="noreferrer noopener"`.
 */

const md = new MarkdownIt({ html: false, linkify: false, breaks: false, typographer: false });

// ---------------------------------------------------------------------------
// Task lists — markdown-it has no GFM task-list rule; flag `- [x]` items so
// the renderer can prefix a disabled checkbox and drop the marker text.
// ---------------------------------------------------------------------------

const TASK_MARKER = /^\[([ xX])\]\s+/;

md.core.ruler.after("inline", "relay-task-lists", (state) => {
	const tokens = state.tokens;
	for (let i = 0; i < tokens.length; i++) {
		const inline = tokens[i];
		if (inline?.type !== "inline") continue;
		// A task item parses as: list_item_open, paragraph_open, inline.
		const itemOpen = tokens[i - 2];
		if (itemOpen?.type !== "list_item_open") continue;
		const match = TASK_MARKER.exec(inline.content);
		if (!match?.[1]) continue;
		itemOpen.meta = { ...(itemOpen.meta ?? {}), task: true, checked: match[1] !== " " };
		inline.content = inline.content.slice(match[0].length);
		const first = inline.children?.[0];
		if (first?.type === "text") first.content = first.content.slice(match[0].length);
	}
});

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

/** Attributes safe to forward to rendered elements (all markdown-it-generated). */
function elementProps(token: Token): Record<string, string> {
	const props: Record<string, string> = {};
	for (const [name, value] of token.attrs ?? []) {
		if (name === "style" || name === "start" || name === "title") props[name] = String(value);
	}
	return props;
}

function attr(token: Token, name: string): string | undefined {
	for (const [key, value] of token.attrs ?? []) {
		if (key === name) return String(value);
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Inline tokens
// ---------------------------------------------------------------------------

interface InlineFrame {
	tag: string;
	props: Record<string, string>;
	children: JSX.Element[];
}

function wrapInline(frame: InlineFrame): JSX.Element {
	if (frame.tag === "a") {
		const href = safeUrl(frame.props["href"]);
		if (!href) return <>{frame.children}</>;
		return (
			<a href={href} target="_blank" rel="noreferrer noopener" title={frame.props["title"]}>
				{frame.children}
			</a>
		);
	}
	return (
		<Dynamic component={frame.tag} {...frame.props}>
			{frame.children}
		</Dynamic>
	);
}

function renderInline(tokens: Token[], key: string): JSX.Element {
	const roots: JSX.Element[] = [];
	const stack: InlineFrame[] = [{ tag: "", props: {}, children: roots }];
	let seq = 0;

	const push = (node: JSX.Element) => stack[stack.length - 1]?.children.push(node);

	for (const token of tokens) {
		switch (token.type) {
			case "text":
				push(token.children ? renderInline(token.children, `${key}-${seq++}`) : token.content);
				break;
			case "code_inline":
				push(<code class="inline-code">{token.content}</code>);
				break;
			case "softbreak":
				push("\n");
				break;
			case "hardbreak":
				push(<br />);
				break;
			case "image": {
				const src = safeUrl(attr(token, "src"));
				const alt = attr(token, "alt") ?? token.content;
				push(src ? <img src={src} alt={alt} /> : <span>{alt}</span>);
				break;
			}
			case "html_inline":
				push(token.content);
				break;
			default:
				if (token.nesting === 1) {
					stack.push({ tag: token.tag, props: elementProps(token), children: [] });
				} else if (token.nesting === -1) {
					const frame = stack.pop();
					if (frame) push(wrapInline(frame));
				} else {
					push(token.content || token.markup);
				}
		}
	}

	// Defensive: close any frames the stream left open.
	while (stack.length > 1) {
		const frame = stack.pop();
		if (frame) push(wrapInline(frame));
	}
	return <>{roots}</>;
}

// ---------------------------------------------------------------------------
// Block tokens
// ---------------------------------------------------------------------------

interface BlockFrame {
	tag: string;
	props: Record<string, string>;
	hidden: boolean;
	task?: boolean;
	checked?: boolean;
	children: JSX.Element[];
}

function wrapBlock(frame: BlockFrame): JSX.Element {
	// Tight-list paragraphs are unwrapped so list items stay compact.
	if (frame.hidden || !frame.tag) return <>{frame.children}</>;
	return (
		<Dynamic component={frame.tag} {...frame.props}>
			{frame.children}
		</Dynamic>
	);
}

function renderBlocks(tokens: Token[]): JSX.Element {
	const roots: JSX.Element[] = [];
	const stack: BlockFrame[] = [{ tag: "", props: {}, hidden: false, children: roots }];
	let seq = 0;

	const push = (node: JSX.Element) => stack[stack.length - 1]?.children.push(node);

	for (const token of tokens) {
		switch (token.type) {
			case "inline":
				push(renderInline(token.children ?? [], `i-${seq++}`));
				break;
			case "fence":
				push(<CodeBlock code={token.content} lang={token.info} />);
				break;
			case "code_block":
				push(<CodeBlock code={token.content} />);
				break;
			case "hr":
				push(<hr />);
				break;
			case "html_block":
				push(token.content);
				break;
			default: {
				if (token.nesting === 1) {
					const meta = token.meta;
					stack.push({
						tag: token.tag,
						props: elementProps(token),
						hidden: token.hidden,
						...(meta?.["task"] === true ? { task: true, checked: meta["checked"] === true } : {}),
						children: [],
					});
				} else if (token.nesting === -1) {
					const frame = stack.pop();
					if (!frame) break;
					// Task list items lead with a disabled checkbox.
					if (frame.task) frame.children.unshift(<input type="checkbox" checked={frame.checked} disabled />);
					push(wrapBlock(frame));
				} else {
					push(token.content || token.markup);
				}
			}
		}
	}

	// Defensive: close any frames the stream left open.
	while (stack.length > 1) {
		const frame = stack.pop();
		if (frame) push(wrapBlock(frame));
	}
	return <>{roots}</>;
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

export function Markdown(props: { content: string }): JSX.Element {
	// Streaming deltas arrive per token; deferring the lex keeps long in-flight
	// messages from being re-parsed on every delta.
	const content = createDeferred(() => props.content, { timeoutMs: 100 });
	return <div class="markdown">{renderBlocks(md.parse(content(), {}))}</div>;
}
