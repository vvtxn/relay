import process from "node:process";

/**
 * Terminal palette introspection.
 *
 * Asks the terminal for its default foreground/background (OSC 10/11) and its
 * 16 ANSI colors (OSC 4), fenced by a primary device-attributes request (DA1).
 * The fence is what keeps this cheap: a terminal that supports none of the
 * color queries still answers DA1, so we fall back immediately instead of
 * waiting out the timeout. Replies are parsed from stdin while it is in raw
 * mode, before the TUI enters the alternate screen.
 */

export interface Rgb {
	r: number;
	g: number;
	b: number;
}

export interface TerminalPalette {
	foreground: Rgb | null;
	background: Rgb | null;
	/** ANSI palette entries 0–15; null when the terminal did not answer. */
	ansi: Array<Rgb | null>;
}

export interface TerminalPaletteQueryOptions {
	/** Maximum wait for the reply fence. Defaults to 200 ms. */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 200;

function isDa1Reply(sequence: string): boolean {
	return sequence.startsWith("\x1b[?") && sequence.endsWith("c");
}

function createPalette(): TerminalPalette {
	return {
		foreground: null,
		background: null,
		ansi: Array.from({ length: 16 }, () => null),
	};
}

function scaleChannel(digits: string): number {
	const max = 16 ** digits.length - 1;
	return Math.round((Number.parseInt(digits, 16) / max) * 255);
}

/**
 * Parse an xterm color specification. Terminals answer with `rgb:R/G/B` (one
 * to four hex digits per channel) or occasionally `#rrggbb`; `rgba:` is
 * accepted and its alpha ignored.
 */
function parseTerminalColor(spec: string): Rgb | null {
	const value = spec.trim().toLowerCase();

	if (value.startsWith("#")) {
		const hex = value.slice(1);
		if (/^[0-9a-f]{3}$/.test(hex)) {
			return {
				r: Number.parseInt(`${hex[0] ?? "0"}${hex[0] ?? "0"}`, 16),
				g: Number.parseInt(`${hex[1] ?? "0"}${hex[1] ?? "0"}`, 16),
				b: Number.parseInt(`${hex[2] ?? "0"}${hex[2] ?? "0"}`, 16),
			};
		}
		if (/^[0-9a-f]{6}$/.test(hex)) {
			return {
				r: Number.parseInt(hex.slice(0, 2), 16),
				g: Number.parseInt(hex.slice(2, 4), 16),
				b: Number.parseInt(hex.slice(4, 6), 16),
			};
		}
		return null;
	}

	const match = /^rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/|$)/.exec(value);
	if (!match) return null;
	return {
		r: scaleChannel(match[1] ?? "0"),
		g: scaleChannel(match[2] ?? "0"),
		b: scaleChannel(match[3] ?? "0"),
	};
}

function applyOsc(body: string, palette: TerminalPalette): void {
	const [codePart, ...values] = body.split(";");
	const code = Number.parseInt(codePart ?? "", 10);

	if (code === 10 || code === 11) {
		const color = parseTerminalColor(values.join(";"));
		if (!color) return;
		if (code === 10) palette.foreground = color;
		else palette.background = color;
		return;
	}

	if (code === 4) {
		const index = Number.parseInt(values[0] ?? "", 10);
		const color = parseTerminalColor(values.slice(1).join(";"));
		if (color && index >= 0 && index < palette.ansi.length) palette.ansi[index] = color;
	}
}

interface ConsumeResult {
	/** Incomplete tail to prepend to the next chunk. */
	rest: string;
	fence: boolean;
}

/** Consume every complete escape sequence in `input`, updating `palette`. */
function consumeTerminalReplies(input: string, palette: TerminalPalette): ConsumeResult {
	let index = 0;
	let rest = "";
	let fence = false;

	while (index < input.length) {
		const escape = input.indexOf("\x1b", index);
		if (escape < 0) {
			// Plain input is not part of a reply; drop it.
			index = input.length;
			break;
		}

		const kind = input[escape + 1];

		// CSI: complete on the first final byte (0x40–0x7e).
		if (kind === "[") {
			let end = escape + 2;
			while (end < input.length) {
				const code = input.charCodeAt(end);
				if (code >= 0x40 && code <= 0x7e) break;
				end++;
			}
			if (end >= input.length) {
				rest = input.slice(escape);
				break;
			}
			if (isDa1Reply(input.slice(escape, end + 1))) fence = true;
			index = end + 1;
			continue;
		}

		// OSC: terminated by BEL or ST.
		if (kind === "]") {
			let end = -1;
			for (let cursor = escape + 2; cursor < input.length; cursor++) {
				if (input[cursor] === "\x07") {
					end = cursor + 1;
					break;
				}
				if (input[cursor] === "\x1b" && input[cursor + 1] === "\\") {
					end = cursor + 2;
					break;
				}
			}
			if (end < 0) {
				rest = input.slice(escape);
				break;
			}
			const terminatedByBel = input[end - 1] === "\x07";
			const body = input.slice(escape + 2, terminatedByBel ? end - 1 : end - 2);
			applyOsc(body, palette);
			index = end;
			continue;
		}

		// DCS/APC/PM/SOS: skip through the string terminator.
		if (kind !== undefined && "P_^X".includes(kind)) {
			const end = input.indexOf("\x1b\\", escape + 2);
			if (end < 0) {
				rest = input.slice(escape);
				break;
			}
			index = end + 2;
			continue;
		}

		// A lone ESC at the chunk boundary may be the start of OSC/CSI.
		if (kind === undefined) {
			rest = input.slice(escape);
			break;
		}

		index = escape + 1;
	}

	return { rest, fence };
}

function querySequence(): string {
	const queries = ["\x1b]10;?\x1b\\", "\x1b]11;?\x1b\\"];
	for (let index = 0; index < 16; index++) queries.push(`\x1b]4;${index};?\x1b\\`);
	// DA1: every terminal answers it, so it fences the color replies.
	queries.push("\x1b[c");
	return queries.join("");
}

/**
 * Query the terminal for its palette. Returns null when stdin/stdout are not a
 * TTY, the terminal is dumb, or it reports no foreground/background.
 */
export function queryTerminalPalette(options: TerminalPaletteQueryOptions = {}): Promise<TerminalPalette | null> {
	const stdin = process.stdin;
	const stdout = process.stdout;

	if (!stdin.isTTY || !stdout.isTTY) return Promise.resolve(null);
	if (process.env.TERM === "dumb") return Promise.resolve(null);

	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const palette = createPalette();
	const wasRaw = stdin.isRaw === true;

	return new Promise((resolve) => {
		let settled = false;
		let pending = "";
		let timer: ReturnType<typeof setTimeout> | null = null;

		const finish = () => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			stdin.off("data", onData);
			try {
				if (!wasRaw && stdin.isTTY) stdin.setRawMode(false);
			} catch {
				/* the terminal is gone; nothing to restore */
			}
			stdin.pause();
			resolve(palette.foreground !== null || palette.background !== null ? palette : null);
		};

		const onData = (chunk: string) => {
			pending += chunk;
			const result = consumeTerminalReplies(pending, palette);
			pending = result.rest;
			if (result.fence) finish();
		};

		try {
			if (stdin.isTTY) stdin.setRawMode(true);
			stdin.setEncoding("utf8");
			stdin.on("data", onData);
			stdin.resume();
			stdout.write(querySequence());
			timer = setTimeout(finish, timeoutMs);
		} catch {
			finish();
		}
	});
}
