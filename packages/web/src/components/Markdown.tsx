import { For, type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { marked, type Token, type Tokens } from "marked";
import { safeUrl } from "./safe-url.ts";

/**
 * Safe markdown renderer.
 *
 * LLM output is untrusted, so this walks `marked`'s token tree and emits Solid
 * elements directly — raw HTML is rendered as text, never injected. Links open
 * in a new tab with `rel="noreferrer noopener"`.
 */

function inline(tokens: Token[] | undefined, key: string): JSX.Element[] {
	if (!tokens) return [];
	return tokens.map((token, i) => renderInline(token, `${key}-${i}`));
}

function renderInline(token: Token, key: string): JSX.Element {
	switch (token.type) {
		case "text": {
			const text = token as Tokens.Text;
			return text.tokens ? <>{inline(text.tokens, key)}</> : (text.text as unknown as JSX.Element);
		}
		case "escape":
			return (token as Tokens.Escape).text;
		case "strong":
			return <strong>{inline((token as Tokens.Strong).tokens, key)}</strong>;
		case "em":
			return <em>{inline((token as Tokens.Em).tokens, key)}</em>;
		case "del":
			return <del>{inline((token as Tokens.Del).tokens, key)}</del>;
		case "codespan":
			return <code class="inline-code">{(token as Tokens.Codespan).text}</code>;
		case "br":
			return <br />;
		case "link": {
			const link = token as Tokens.Link;
			const href = safeUrl(link.href);
			const children = inline(link.tokens, key);
			return href
				? (
					<a href={href} target="_blank" rel="noreferrer noopener">
						{children}
					</a>
				)
				: <>{children}</>;
		}
		case "image": {
			const image = token as Tokens.Image;
			const src = safeUrl(image.href);
			return src ? <img src={src} alt={image.text} /> : <span>{image.text}</span>;
		}
		case "html":
			return (token as Tokens.HTML).text;
		default:
			return (token as { raw?: string }).raw ?? "";
	}
}

function renderBlock(token: Token, key: string): JSX.Element {
	switch (token.type) {
		case "space":
			return null as unknown as JSX.Element;
		case "paragraph": {
			const paragraph = token as Tokens.Paragraph;
			return <p>{paragraph.tokens ? inline(paragraph.tokens, key) : paragraph.text}</p>;
		}
		case "heading": {
			const heading = token as Tokens.Heading;
			return (
				<Dynamic component={`h${heading.depth}`}>
					{inline(heading.tokens, key)}
				</Dynamic>
			);
		}
		case "code": {
			const code = token as Tokens.Code;
			return (
				<pre class="code-block">
					<code class={code.lang ? `language-${code.lang}` : undefined}>{code.text}</code>
				</pre>
			);
		}
		case "blockquote": {
			const quote = token as Tokens.Blockquote;
			return <blockquote>{quote.tokens.map((child, i) => renderBlock(child, `${key}-${i}`))}</blockquote>;
		}
		case "hr":
			return <hr />;
		case "list": {
			const list = token as Tokens.List;
			const items = list.items.map((item, i) => (
				<li>
					<Show when={item.task} fallback={renderListItem(item, `${key}-${i}`)}>
						<input type="checkbox" checked={item.checked} disabled /> {renderListItem(item, `${key}-${i}`)}
					</Show>
				</li>
			));
			return list.ordered
				? <ol start={typeof list.start === "number" ? list.start : undefined}>{items}</ol>
				: <ul>{items}</ul>;
		}
		case "table": {
			const table = token as Tokens.Table;
			return (
				<table>
					<thead>
						<tr>
							<For each={table.header}>
								{(cell, i) => <th>{inline(cell.tokens, `${key}-h-${i()}`)}</th>}
							</For>
						</tr>
					</thead>
					<tbody>
						<For each={table.rows}>
							{(row, r) => (
								<tr>
									<For each={row}>
										{(cell, c) => <td>{inline(cell.tokens, `${key}-${r()}-${c()}`)}</td>}
									</For>
								</tr>
							)}
						</For>
					</tbody>
				</table>
			);
		}
		case "html":
			return <p>{(token as Tokens.HTML).text}</p>;
		default:
			return <p>{(token as { raw?: string }).raw ?? ""}</p>;
	}
}

function renderListItem(item: Tokens.ListItem, key: string): JSX.Element {
	const content = item.tokens ? item.tokens.map((child, i) => renderBlock(child, `${key}-${i}`)) : item.text;
	return <>{content}</>;
}

export function Markdown(props: { content: string }): JSX.Element {
	const tokens = () => marked.lexer(props.content);
	return (
		<div class="markdown">
			<For each={tokens()}>{(token, i) => renderBlock(token, `b-${i()}`)}</For>
		</div>
	);
}
