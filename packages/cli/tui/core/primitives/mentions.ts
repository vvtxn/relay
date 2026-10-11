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
