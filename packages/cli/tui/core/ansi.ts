// ── Terminal Control ─────────────────────────────────────────────────────────

/** Enter alternate screen buffer (preserves main scrollback) */
export const ENTER_ALT_SCREEN = "\x1b[?1049h";
/** Exit alternate screen buffer (restores main scrollback) */
export const EXIT_ALT_SCREEN = "\x1b[?1049l";
/** Clear entire screen and move cursor to top-left */
export const CLEAR_SCREEN = "\x1b[2J\x1b[H";

// ── Mouse Tracking (SGR extended mode) ──────────────────────────────────────

/** Enable button + wheel reporting with SGR coordinates (`\x1b[<b;x;yM`) */
export const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
/** Disable mouse reporting (SGR + button mode) */
export const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1000l";

// ── OSC Terminal Colors (OSC 11) ────────────────────────────────────────────

/** Set the terminal's default background color to a `#rrggbb` value */
export function oscSetBackground(hex: string): string {
	return `\x1b]11;${hex}\x1b\\`;
}

/** Restore the terminal's default background color */
export const OSC_RESET_BACKGROUND = "\x1b]111\x1b\\";

// ── Cursor Visibility ───────────────────────────────────────────────────────

/** Hide the cursor */
export const CURSOR_HIDE = "\x1b[?25l";
/** Show the cursor */
export const CURSOR_SHOW = "\x1b[?25h";
/** Set cursor shape to steady (non-blinking) block */
export const CURSOR_BLOCK = "\x1b[2 q";
/** Reset cursor shape to terminal default */
export const CURSOR_DEFAULT = "\x1b[0 q";

/** Move cursor to row;col (1-indexed) */
export function cursorTo(row: number, col: number): string {
	return `\x1b[${row};${col}H`;
}

// ── Synchronized Output ─────────────────────────────────────────────────────

/** Begin synchronized update — terminal defers rendering until SYNC_END */
export const SYNC_START = "\x1b[?2026h";
/** End synchronized update — terminal renders buffered output atomically */
export const SYNC_END = "\x1b[?2026l";

// ── SGR (Select Graphic Rendition) Reset ────────────────────────────────────

/** Reset all attributes (color, bold, italic, etc.) */
export const RESET = "\x1b[0m";
/** Reset foreground color only */
export const RESET_FG = "\x1b[39m";
/** Reset background color only */
export const RESET_BG = "\x1b[49m";

// ── SGR Text Attributes ────────────────────────────────────────────────────

/** Bold on */
export const BOLD = "\x1b[1m";
/** Bold off */
export const BOLD_OFF = "\x1b[22m";
/** Italic on */
export const ITALIC = "\x1b[3m";
/** Italic off */
export const ITALIC_OFF = "\x1b[23m";
/** Underline on */
export const UNDERLINE = "\x1b[4m";
/** Underline off */
export const UNDERLINE_OFF = "\x1b[24m";
/** Strikethrough on */
export const STRIKETHROUGH = "\x1b[9m";
/** Strikethrough off */
export const STRIKETHROUGH_OFF = "\x1b[29m";

// ── SGR Color Helpers ───────────────────────────────────────────────────────

/** Foreground color using 24-bit RGB */
export function fgRgb(r: number, g: number, b: number): string {
	return `\x1b[38;2;${r};${g};${b}m`;
}

/** Background color using 24-bit RGB */
export function bgRgb(r: number, g: number, b: number): string {
	return `\x1b[48;2;${r};${g};${b}m`;
}

// ── CSI Sequence Detection ──────────────────────────────────────────────────

/** CSI (Control Sequence Introducer) prefix for escape sequences */
export const CSI = "\x1b[";
