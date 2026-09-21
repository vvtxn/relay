export interface LineWithOffset {
	line: string;
	startIndex: number;
}

/**
 * Wraps text to a specified width, splitting by words and preserving spaces.
 * Returns an array of lines with their starting character index in the original text.
 */
export function wrapTextWithOffsets(text: string, width: number): LineWithOffset[] {
	if (width <= 0) return [];

	const str = String(text || "");
	const result: LineWithOffset[] = [];
	const words = str.split(" ");
	let currentLine = "";
	let lineStart = 0;

	for (let wi = 0; wi < words.length; wi++) {
		const word = words[wi] ?? "";
		if (word.length > width) {
			if (currentLine) {
				result.push({ line: currentLine, startIndex: lineStart });
				lineStart += currentLine.length + 1;
				currentLine = "";
			}
			for (let i = 0; i < word.length; i += width) {
				const chunk = word.slice(i, i + width);
				result.push({ line: chunk, startIndex: lineStart + i });
			}
			lineStart += word.length + (wi < words.length - 1 ? 1 : 0);
			continue;
		}

		const testLine = currentLine ? `${currentLine} ${word}` : word;

		if (testLine.length <= width) {
			currentLine = testLine;
		} else {
			if (currentLine) {
				result.push({ line: currentLine, startIndex: lineStart });
				lineStart += currentLine.length + 1;
			}
			currentLine = word;
		}
	}

	if (currentLine) {
		result.push({ line: currentLine, startIndex: lineStart });
	}

	return result.length > 0 ? result : [{ line: "", startIndex: 0 }];
}

/**
 * Wraps text to a specified width, splitting by words and preserving spaces.
 * Returns an array of lines, each not exceeding the specified width.
 */
export function wrapText(text: string, width: number): string[] {
	return wrapTextWithOffsets(text, width).map((l) => l.line);
}

/**
 * Splits text into lines of specified width without word wrapping, tracking offsets.
 * Simply breaks text every `width` characters.
 */
export function splitTextWithOffsets(text: string, width: number): LineWithOffset[] {
	if (width <= 0) return [];

	const str = String(text || "");
	const result: LineWithOffset[] = [];
	for (let i = 0; i < str.length; i += width) {
		result.push({ line: str.slice(i, i + width), startIndex: i });
	}

	return result.length > 0 ? result : [{ line: "", startIndex: 0 }];
}

/**
 * Splits text into lines of specified width without word wrapping.
 * Simply breaks text every `width` characters.
 */
export function splitText(text: string, width: number): string[] {
	return splitTextWithOffsets(text, width).map((l) => l.line);
}
