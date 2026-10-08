/**
 * Terminal spacing tokens — one unit is one character cell.
 *
 * Relay's TUI has no borders: hierarchy comes from the background steps
 * (`background` → `surface` → `surfaceElevated`) plus spacing. Horizontal and
 * vertical space are deliberately different. A wide horizontal gutter reads as
 * a page margin, but the same number of blank rows between every line would
 * waste half the screen — so `paddingX` and `paddingY` are set independently.
 *
 * Layout rules:
 *
 * - **One gutter.** Every top-level region (status bar, chat, composer) aligns
 *   its content to the same horizontal inset. Surfaces are full-bleed and carry
 *   the gutter in their own `paddingX`; they are never nested inside another
 *   padded container, which would double the inset and misalign the columns.
 * - **Sections breathe with background, not padding.** Regions are separated by
 *   a single blank row showing the base background, so surfaces stay flush to
 *   the terminal edges.
 * - **Cards stack.** A message or composer is a full-bleed surface padded by
 *   `cardX` / `cardY`; consecutive cards sit flush so their combined padding
 *   yields the vertical rhythm.
 */

/** Raw scale, in character cells. Prefer the semantic roles below. */
export const spacing = {
	none: 0,
	/** A single cell. */
	xs: 1,
	/** Two cells — the page gutter. */
	sm: 2,
	/** Three cells. */
	md: 3,
	/** Four cells. */
	lg: 4,
} as const;

/**
 * Semantic spacing roles:
 *
 * - `gutter`  — the one horizontal page margin.
 * - `section` — vertical gap between major regions.
 * - `cardX` / `cardY` — inner padding of a full-bleed surface (message, composer).
 * - `block`   — vertical gap between stacked children of a block.
 * - `inline`  — gap between an icon/bullet and its label, or adjacent row tokens.
 * - `rail`    — width of the colored left rail that marks a message card.
 * - `overlayX` / `overlayY` — padding inside a floating panel (palette, approval).
 */
export const space = {
	gutter: spacing.sm,
	section: spacing.xs,
	cardX: spacing.sm,
	cardY: spacing.xs,
	block: spacing.xs,
	inline: spacing.xs,
	rail: spacing.xs,
	overlayX: spacing.sm,
	overlayY: spacing.xs,
} as const;
