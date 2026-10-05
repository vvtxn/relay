import { RESET_FG } from "@/tui/core/ansi.ts";

export interface MentionRange {
	start: number;
	end: number;
}

export const MENTION_RE = /(^|(?<=\s))@[^\s]+/g;

export function findMentions(text: string): MentionRange[] {
	const ranges: MentionRange[] = [];
	for (const match of text.matchAll(MENTION_RE)) {
		ranges.push({ start: match.index!, end: match.index! + match[0].length });
	}
	return ranges;
}

export function formatLineWithMentions(
	line: string,
	lineStart: number,
	width: number,
	mentions: MentionRange[],
	defaultAnsi: string | null,
	mentionAnsi: string,
): string {
	const padded = line.slice(0, width).padEnd(width, " ");
	if (mentions.length === 0) {
		if (defaultAnsi) return `${defaultAnsi}${padded}${RESET_FG}`;
		return padded;
	}

	let result = "";
	let inMention = false;

	for (let i = 0; i < padded.length; i++) {
		const absIdx = lineStart + i;
		const isMention = i < line.length && mentions.some((m) => absIdx >= m.start && absIdx < m.end);

		if (isMention !== inMention) {
			if (isMention) {
				result += `${mentionAnsi}`;
			} else {
				result += `${RESET_FG}${defaultAnsi ?? ""}`;
			}
			inMention = isMention;
		}
		result += padded[i];
	}

	result += RESET_FG;
	return result;
}
