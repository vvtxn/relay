export interface MentionRange {
	start: number;
	end: number;
}

export interface MentionSegment {
	text: string;
	mention: boolean;
}

export const MENTION_RE = /(^|(?<=\s))@[^\s]+/g;

export function findMentions(text: string): MentionRange[] {
	const ranges: MentionRange[] = [];
	for (const match of text.matchAll(MENTION_RE)) {
		ranges.push({ start: match.index!, end: match.index! + match[0].length });
	}
	return ranges;
}

/** Split `text` into plain and `@path` mention segments, preserving order. */
export function splitMentions(text: string): MentionSegment[] {
	const segments: MentionSegment[] = [];
	let last = 0;
	for (const match of text.matchAll(MENTION_RE)) {
		const start = match.index! + (match[1]?.length ?? 0);
		if (start > last) segments.push({ text: text.slice(last, start), mention: false });
		segments.push({ text: match[0].slice(match[1]?.length ?? 0), mention: true });
		last = start + (match[0].length - (match[1]?.length ?? 0));
	}
	if (last < text.length) segments.push({ text: text.slice(last), mention: false });
	return segments;
}
