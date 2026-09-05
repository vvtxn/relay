import type { ComponentChild } from "preact";

// ---------------------------------------------------------------------------
// Inline rendering — `code`, **bold**, *italic*, [text](url)
// ---------------------------------------------------------------------------

const INLINE_PATTERN = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)\s]+\))/g;

function renderInline(text: string, keyPrefix: string): ComponentChild[] {
	const nodes: ComponentChild[] = [];
	let last = 0;
	let index = 0;
	let match: RegExpExecArray | null;

	INLINE_PATTERN.lastIndex = 0;
	while ((match = INLINE_PATTERN.exec(text)) !== null) {
		if (match.index > last) nodes.push(text.slice(last, match.index));
		const token = match[0];
		const key = `${keyPrefix}-${index++}`;

		if (token.startsWith("`")) {
			nodes.push(<code key={key} class="inline-code">{token.slice(1, -1)}</code>);
		} else if (token.startsWith("**")) {
			nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
		} else if (token.startsWith("*")) {
			nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
		} else {
			const link = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
			nodes.push(
				link
					? (
						<a key={key} href={link[2]} target="_blank" rel="noreferrer noopener">
							{link[1]}
						</a>
					)
					: token,
			);
		}
		last = INLINE_PATTERN.lastIndex;
	}
	if (last < text.length) nodes.push(text.slice(last));
	return nodes;
}

// ---------------------------------------------------------------------------
// Block rendering — fences, headings, lists, quotes, hr, paragraphs
// ---------------------------------------------------------------------------

function isListItem(line: string): boolean {
	return /^[-*] /.test(line);
}

function isOrderedList(line: string): boolean {
	return /^\d+\. /.test(line);
}

function isSpecial(line: string): boolean {
	return (
		line.startsWith("```") ||
		line.startsWith("#") ||
		isListItem(line) ||
		isOrderedList(line) ||
		line.startsWith("> ") ||
		/^(---|\*\*\*|___)$/.test(line.trim())
	);
}

function parseBlocks(lines: string[], keyPrefix = "b"): ComponentChild[] {
	const blocks: ComponentChild[] = [];
	let i = 0;
	let key = 0;

	while (i < lines.length) {
		const line = lines[i];
		const blockKey = `${keyPrefix}-${key++}`;

		if (line.startsWith("```")) {
			const lang = line.slice(3).trim();
			const content: string[] = [];
			i++;
			while (i < lines.length && !lines[i].startsWith("```")) {
				content.push(lines[i]);
				i++;
			}
			i++; // skip closing fence (or run past end)
			blocks.push(
				<pre key={blockKey} class="code-block" data-lang={lang || undefined}>
					<code>{content.join("\n")}</code>
				</pre>,
			);
			continue;
		}

		const heading = line.match(/^(#{1,4}) (.+)$/);
		if (heading) {
			const level = heading[1].length;
			const content = renderInline(heading[2], blockKey);
			blocks.push(
				level === 1
					? <h1 key={blockKey}>{content}</h1>
					: level === 2
					? <h2 key={blockKey}>{content}</h2>
					: level === 3
					? <h3 key={blockKey}>{content}</h3>
					: <h4 key={blockKey}>{content}</h4>,
			);
			i++;
			continue;
		}

		if (isListItem(line) || isOrderedList(line)) {
			const ordered = isOrderedList(line);
			const items: string[] = [];
			while (i < lines.length && (ordered ? isOrderedList(lines[i]) : isListItem(lines[i]))) {
				items.push(lines[i].replace(/^\d+\. |^[-*] /, ""));
				i++;
			}
			const rendered = items.map((item, idx) => <li key={idx}>{renderInline(item, `${blockKey}-${idx}`)}</li>);
			blocks.push(ordered ? <ol key={blockKey}>{rendered}</ol> : <ul key={blockKey}>{rendered}</ul>);
			continue;
		}

		if (line.startsWith("> ")) {
			const quoted: string[] = [];
			while (i < lines.length && lines[i].startsWith("> ")) {
				quoted.push(lines[i].slice(2));
				i++;
			}
			blocks.push(<blockquote key={blockKey}>{parseBlocks(quoted, blockKey)}</blockquote>);
			continue;
		}

		if (/^(---|\*\*\*|___)$/.test(line.trim())) {
			blocks.push(<hr key={blockKey} />);
			i++;
			continue;
		}

		if (!line.trim()) {
			i++;
			continue;
		}

		// Paragraph: merge consecutive plain lines
		const paragraph: string[] = [];
		while (i < lines.length && lines[i].trim() && !isSpecial(lines[i])) {
			paragraph.push(lines[i]);
			i++;
		}
		blocks.push(<p key={blockKey}>{renderInline(paragraph.join("\n"), blockKey)}</p>);
	}

	return blocks;
}

export function Markdown({ text }: { text: string }) {
	return <div class="markdown">{parseBlocks(text.split("\n"))}</div>;
}
