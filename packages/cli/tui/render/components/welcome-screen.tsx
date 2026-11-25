import { toAnsi } from "#/tui/core/primitives/color.ts";
import { theme } from "#/tui/theme.ts";
import { Box, Text } from "../components.tsx";
import { useSignal, useSignalEffect } from "../hooks/signals.ts";

/**
 * Welcome mark: a halftone signal orb. A slowly rotating sphere of cells whose
 * glyph density and color follow waves of current sweeping across the surface —
 * a terminal-native take on the web client's canvas orb. Lit from the active
 * palette (faint → silver, with a hint of accent at the hot core) so it tracks
 * the terminal's colors instead of hardcoding one.
 */

/** Cells across the orb. Terminal cells are ~1:2, so a 2:1 grid reads as a circle. */
const ORB_COLS = 26;
const ORB_ROWS = 13;
/** Copy column width; Yoga shrinks it on narrow terminals so the hints re-wrap. */
const COPY_COLS = 50;
const FRAME_MS = 50;
const SPIN_SPEED = 0.42;
const WAVE_SPEED = 1.55;
const RIPPLE_SPEED = 1.1;
const TILT = -0.34;
const FRAME_WRAP = 100_000;

/** Level 0 is outside the disc; 4 and 5 differ mainly in color (silver → accent). */
const GLYPHS = [" ", "·", ":", "•", "•", "●"] as const;

interface OrbCell {
	/** Unit-sphere position. */
	x: number;
	y: number;
	z: number;
	polar: number;
	azimuth: number;
}

function buildRows(): Array<Array<OrbCell | undefined>> {
	const rows: Array<Array<OrbCell | undefined>> = Array.from({ length: ORB_ROWS }, () => []);
	const halfCols = ORB_COLS / 2;
	const halfRows = ORB_ROWS / 2;
	for (let row = 0; row < ORB_ROWS; row++) {
		for (let col = 0; col < ORB_COLS; col++) {
			const nx = (col + 0.5 - halfCols) / halfCols;
			const ny = (row + 0.5 - halfRows) / halfRows;
			const radiusSquared = nx * nx + ny * ny;
			if (radiusSquared > 1) continue;
			const z = Math.sqrt(Math.max(0, 1 - radiusSquared));
			rows[row]![col] = {
				x: nx,
				y: ny,
				z,
				polar: Math.acos(Math.max(-1, Math.min(1, ny))),
				azimuth: Math.atan2(z, nx),
			};
		}
	}
	return rows;
}

const ORB_ROWS_CELLS = buildRows();

/** Luminance for one cell in [0, 1]: depth shading times two crossing waves. */
function luminance(cell: OrbCell, clock: number): number {
	const spin = clock * SPIN_SPEED;
	const cosY = Math.cos(spin);
	const sinY = Math.sin(spin);
	const z1 = -cell.x * sinY + cell.z * cosY;
	const cosX = Math.cos(TILT);
	const sinX = Math.sin(TILT);
	const z2 = cell.y * sinX + z1 * cosX;
	const depth = (z2 + 1) / 2;

	const warp = Math.sin(cell.azimuth * 2 + clock * 0.6);
	const energy = 0.5 + 0.5 * Math.sin(cell.polar * 2.3 - clock * WAVE_SPEED + warp);
	const ripples = 0.5 + 0.5 * Math.sin(cell.azimuth * 3 - clock * RIPPLE_SPEED + cell.polar * 1.6);
	return energy * (0.45 + 0.55 * ripples) * (0.4 + 0.6 * depth);
}

function levelOf(lum: number): number {
	if (lum < 0.32) return 1;
	if (lum < 0.5) return 2;
	if (lum < 0.68) return 3;
	if (lum < 0.85) return 4;
	return 5;
}

/** One row of the orb as a string, with ANSI color runs grouped per level. */
function renderRow(cells: Array<OrbCell | undefined>, clock: number, colors: Array<string | null>): string {
	let line = "";
	let active = "";
	for (let col = 0; col < ORB_COLS; col++) {
		const cell = cells[col];
		const level = cell ? levelOf(luminance(cell, clock)) : 0;
		const color = colors[level] ?? null;
		if (color && color !== active) {
			line += color;
			active = color;
		}
		line += GLYPHS[level] ?? " ";
	}
	return line;
}

function palette(): Array<string | null> {
	return [
		null,
		toAnsi(theme.textDim),
		toAnsi(theme.textMuted),
		toAnsi(theme.text),
		toAnsi(theme.heading1),
		toAnsi(theme.mention),
	];
}

export interface WelcomeScreenProps {
	subtitle?: string | undefined;
	hints?: string | undefined;
}

export function WelcomeScreen({ subtitle = "Type a message to get started", hints }: WelcomeScreenProps) {
	const frame = useSignal(0);

	useSignalEffect(() => {
		const timer = setInterval(() => {
			frame.value = (frame.value + 1) % FRAME_WRAP;
		}, FRAME_MS);
		return () => clearInterval(timer);
	});

	const clock = frame.value * (FRAME_MS / 1000);
	const colors = palette();
	const rows = ORB_ROWS_CELLS.map((cells) => renderRow(cells, clock, colors));

	return (
		<Box flex flexDirection="row" justifyContent="center" alignItems="center" gap={3} paddingBottom={1}>
			<Box flexDirection="column" width={ORB_COLS}>
				{rows.map((line, index) => (
					// Fixed width + height: Yoga skips re-measuring the animated rows.
					<Text key={index} width={ORB_COLS} height={1}>
						{line}
					</Text>
				))}
			</Box>
			<Box flexDirection="column" gap={1} width={COPY_COLS}>
				<Text color={theme.brand} bold>
					Welcome to Relay
				</Text>
				<Box flexDirection="column">
					<Text color={theme.textDim} italic>
						{subtitle}
					</Text>
					{hints && (
						<Text color={theme.textFaint} italic>
							{hints}
						</Text>
					)}
				</Box>
			</Box>
		</Box>
	);
}
