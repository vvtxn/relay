import { theme } from "@/tui/theme.ts";

/** Represents a parsed markdown segment with styling */
export interface MarkdownSegment {
	text: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	code?: boolean;
	color?: string;
}

/** Represents a parsed markdown line */
export interface MarkdownLine {
	segments: MarkdownSegment[];
	type: "paragraph" | "heading1" | "heading2" | "heading3" | "code" | "blockquote" | "listItem" | "hr";
	indent?: number;
	/** Language tag from fenced code blocks (e.g. "diff", "ts", "python") */
	language?: string;
}

interface InlinePattern {
	regex: RegExp;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	code?: boolean;
	link?: boolean;
}

interface InlineMatch {
	start: number;
	end: number;
	text: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	code?: boolean;
	url?: string;
}

/** Parse inline markdown formatting (bold, italic, code, strikethrough) */
function parseInlineFormatting(text: string): MarkdownSegment[] {
	const segments: MarkdownSegment[] = [];

	const patterns: InlinePattern[] = [
		{ regex: /\*\*\*(.+?)\*\*\*/g, bold: true, italic: true },
		{ regex: /\*\*(.+?)\*\*/g, bold: true },
		{ regex: /\*(.+?)\*/g, italic: true },
		{ regex: /__(.+?)__/g, bold: true },
		{ regex: /_(.+?)_/g, italic: true },
		{ regex: /~~(.+?)~~/g, strikethrough: true },
		{ regex: /`(.+?)`/g, code: true },
		{ regex: /\[([^\]]+)\]\(([^)]+)\)/g, underline: true, link: true },
	];

	const matches: InlineMatch[] = [];

	for (const pattern of patterns) {
		const regex = new RegExp(pattern.regex.source, "g");
		let match: RegExpExecArray | null;
		while ((match = regex.exec(text)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			const overlaps = matches.some(
				(m) => (start >= m.start && start < m.end) || (end > m.start && end <= m.end),
			);
			if (overlaps) continue;

			const entry: InlineMatch = { start, end, text: match[1] ?? "" };
			if (pattern.bold) entry.bold = true;
			if (pattern.italic) entry.italic = true;
			if (pattern.underline) entry.underline = true;
			if (pattern.strikethrough) entry.strikethrough = true;
			if (pattern.code) entry.code = true;
			const url = match[2];
			if (pattern.link && url) entry.url = url;
			matches.push(entry);
		}
	}

	matches.sort((a, b) => a.start - b.start);

	let pos = 0;
	for (const match of matches) {
		if (match.start > pos) segments.push({ text: text.slice(pos, match.start) });

		const segment: MarkdownSegment = { text: match.text };
		if (match.bold) segment.bold = true;
		if (match.italic) segment.italic = true;
		if (match.underline) segment.underline = true;
		if (match.strikethrough) segment.strikethrough = true;
		if (match.code) segment.code = true;
		if (match.code) segment.color = theme.codeInline;
		else if (match.url) segment.color = theme.link;
		segments.push(segment);

		if (match.url) segments.push({ text: ` (${match.url})`, color: theme.linkUrl });
		pos = match.end;
	}

	if (pos < text.length) {
		segments.push({ text: text.slice(pos) });
	}

	return segments.length > 0 ? segments : [{ text }];
}

/** Colorize a code block line based on its language */
function colorizeCodeLine(line: string, language: string | undefined): MarkdownSegment[] {
	if (language === "diff") {
		if (line.startsWith("+++") || line.startsWith("---")) {
			return [{ text: line, code: true, bold: true, color: theme.text }];
		}
		if (line.startsWith("@@")) {
			return [{ text: line, code: true, color: theme.accent }];
		}
		if (line.startsWith("+")) {
			return [{ text: line, code: true, color: theme.success }];
		}
		if (line.startsWith("-")) {
			return [{ text: line, code: true, color: theme.error }];
		}
		return [{ text: line, code: true, color: theme.codeBlock }];
	}
	return [{ text: line, code: true, color: theme.codeBlock }];
}

/** Parse markdown text into structured lines */
export function parseMarkdown(content: string): MarkdownLine[] {
	const lines = content.split("\n");
	const result: MarkdownLine[] = [];
	let inCodeBlock = false;
	let codeLanguage: string | undefined;

	for (const line of lines) {
		// Code block toggle
		if (line.trim().startsWith("```")) {
			if (!inCodeBlock) {
				codeLanguage = line.trim().slice(3).trim() || undefined;
			} else {
				codeLanguage = undefined;
			}
			inCodeBlock = !inCodeBlock;
			continue;
		}

		// Inside code block
		if (inCodeBlock) {
			result.push({
				type: "code",
				segments: colorizeCodeLine(line, codeLanguage),
				...(codeLanguage ? { language: codeLanguage } : {}),
			});
			continue;
		}

		const trimmed = line.trim();

		// Empty line
		if (!trimmed) {
			result.push({ type: "paragraph", segments: [{ text: "" }] });
			continue;
		}

		// Horizontal rule
		if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
			result.push({
				type: "hr",
				segments: [{ text: "─".repeat(40), color: theme.hr }],
			});
			continue;
		}

		// Headings
		const h3Match = trimmed.match(/^###\s+(.+)$/);
		if (h3Match) {
			result.push({
				type: "heading3",
				segments: [{ text: h3Match[1] ?? "", bold: true, color: theme.heading3 }],
			});
			continue;
		}

		const h2Match = trimmed.match(/^##\s+(.+)$/);
		if (h2Match) {
			result.push({
				type: "heading2",
				segments: [{ text: h2Match[1] ?? "", bold: true, color: theme.heading2 }],
			});
			continue;
		}

		const h1Match = trimmed.match(/^#\s+(.+)$/);
		if (h1Match) {
			result.push({
				type: "heading1",
				segments: [{ text: h1Match[1] ?? "", bold: true, color: theme.heading1 }],
			});
			continue;
		}

		// Blockquote
		const quoteMatch = trimmed.match(/^>\s*(.*)$/);
		if (quoteMatch) {
			result.push({
				type: "blockquote",
				segments: [
					{ text: "│ ", color: theme.blockquote },
					...parseInlineFormatting(quoteMatch[1] ?? "").map((s) => ({ ...s, italic: true })),
				],
			});
			continue;
		}

		// List items (with indentation support)
		const indentedListMatch = line.match(/^(\s*)([-*+])\s+(.+)$/);
		if (indentedListMatch) {
			const indent = Math.floor((indentedListMatch[1] ?? "").length / 2);
			const bullet = indent === 0 ? "• " : indent === 1 ? "◦ " : "▪ ";
			const padding = "  ".repeat(indent);
			result.push({
				type: "listItem",
				segments: [
					{ text: `${padding}${bullet}`, color: theme.listBullet },
					...parseInlineFormatting(indentedListMatch[3] ?? ""),
				],
				indent,
			});
			continue;
		}

		// Numbered list (with indentation support)
		const numListMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
		if (numListMatch) {
			const indent = Math.floor((numListMatch[1] ?? "").length / 2);
			const padding = "  ".repeat(indent);
			result.push({
				type: "listItem",
				segments: [
					{ text: `${padding}${numListMatch[2] ?? ""}. `, color: theme.listBullet },
					...parseInlineFormatting(numListMatch[3] ?? ""),
				],
				indent,
			});
			continue;
		}

		// Regular paragraph with inline formatting
		result.push({
			type: "paragraph",
			segments: parseInlineFormatting(trimmed),
		});
	}

	return result;
}
