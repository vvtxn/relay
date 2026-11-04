import { createSignal, onCleanup, onMount } from "solid-js";

/**
 * A fluid ASCII relay: an armature swings between two contacts while current
 * flows along the live branch. Drawn into a character grid and re-rendered on
 * an animation frame; the whole thing is decorative, so it is hidden from
 * assistive tech and freezes on a single frame under reduced motion.
 */

const WIDTH = 68;
const HEIGHT = 22;
const FRAME_MS = 1000 / 30;
const PERIOD_MS = 4600;

type Grid = string[][];
interface Point {
	x: number;
	y: number;
}

function makeGrid(): Grid {
	return Array.from({ length: HEIGHT }, () => Array.from({ length: WIDTH }, () => " "));
}

function put(grid: Grid, x: number, y: number, ch: string): void {
	const xi = Math.round(x);
	const yi = Math.round(y);
	if (xi < 0 || xi >= WIDTH || yi < 0 || yi >= HEIGHT) return;
	grid[yi]![xi] = ch;
}

function putText(grid: Grid, x: number, y: number, text: string): void {
	for (let i = 0; i < text.length; i++) put(grid, x + i, y, text[i]!);
}

function drawLine(grid: Grid, x0: number, y0: number, x1: number, y1: number, ch?: string): void {
	let x = Math.round(x0);
	let y = Math.round(y0);
	const ex = Math.round(x1);
	const ey = Math.round(y1);
	const dx = Math.abs(ex - x);
	const dy = Math.abs(ey - y);
	const sx = x < ex ? 1 : -1;
	const sy = y < ey ? 1 : -1;
	let err = dx - dy;
	for (;;) {
		const c = ch ?? (dx === 0 ? "│" : dy === 0 ? "─" : sx === sy ? "╲" : "╱");
		put(grid, x, y, c);
		if (x === ex && y === ey) break;
		const e2 = 2 * err;
		if (e2 > -dy) {
			err -= dy;
			x += sx;
		}
		if (e2 < dx) {
			err += dx;
			y += sy;
		}
	}
}

function cornerChar(inDir: Point, outDir: Point): string {
	const dirs = new Set([`${inDir.x},${inDir.y}`, `${outDir.x},${outDir.y}`]);
	const has = (x: number, y: number) => dirs.has(`${x},${y}`);
	if (has(0, 1) && has(-1, 0)) return "┘";
	if (has(0, 1) && has(1, 0)) return "└";
	if (has(0, -1) && has(-1, 0)) return "┐";
	if (has(0, -1) && has(1, 0)) return "┌";
	return "┼";
}

function drawWire(grid: Grid, path: Point[]): void {
	for (let i = 1; i < path.length; i++) {
		drawLine(grid, path[i - 1]!.x, path[i - 1]!.y, path[i]!.x, path[i]!.y);
	}
	for (let i = 1; i < path.length - 1; i++) {
		const prev = path[i - 1]!;
		const cur = path[i]!;
		const next = path[i + 1]!;
		put(
			grid,
			cur.x,
			cur.y,
			cornerChar(
				{ x: Math.sign(cur.x - prev.x), y: Math.sign(cur.y - prev.y) },
				{ x: Math.sign(next.x - cur.x), y: Math.sign(next.y - cur.y) },
			),
		);
	}
}

function pathLength(path: Point[]): number {
	let total = 0;
	for (let i = 1; i < path.length; i++) {
		total += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
	}
	return total;
}

function pointAt(path: Point[], s: number): Point {
	let target = Math.min(1, Math.max(0, s)) * pathLength(path);
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1]!;
		const b = path[i]!;
		const seg = Math.hypot(b.x - a.x, b.y - a.y);
		if (target <= seg) {
			const f = seg === 0 ? 0 : target / seg;
			return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
		}
		target -= seg;
	}
	return path[path.length - 1]!;
}

const PIVOT: Point = { x: 34, y: 14 };
const ARM_LEN = 10;
const MAX_ANGLE = 0.62;
const LEFT_CONTACT: Point = { x: 28, y: 5 };
const RIGHT_CONTACT: Point = { x: 40, y: 5 };
const LEFT_PATH: Point[] = [LEFT_CONTACT, { x: 28, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 19 }];
const RIGHT_PATH: Point[] = [RIGHT_CONTACT, { x: 40, y: 2 }, { x: 60, y: 2 }, { x: 60, y: 19 }];
const COIL_PATH: Point[] = [PIVOT, { x: 34, y: 19 }];
const COIL_LEFT = 12;
const COIL_TOP = 16;

function easeOutBack(x: number): number {
	const c1 = 1.70158;
	const c3 = c1 + 1;
	const c = Math.min(1, Math.max(0, x));
	return 1 + c3 * (c - 1) ** 3 + c1 * (c - 1) ** 2;
}

/** Armature position in [-1, 1]: a springy snap between the two contacts with a hold at each. */
function armatureValue(t: number): number {
	const u = (((t % PERIOD_MS) + PERIOD_MS) % PERIOD_MS) / PERIOD_MS;
	const move = 0.16;
	const hold = 0.34;
	if (u < move) return -1 + 2 * easeOutBack(u / move);
	if (u < move + hold) return 1;
	if (u < 2 * move + hold) return 1 - 2 * easeOutBack((u - move - hold) / move);
	return -1;
}

function drawArmature(grid: Grid, angle: number, ch?: string): void {
	const ex = PIVOT.x + ARM_LEN * Math.sin(angle);
	const ey = PIVOT.y - ARM_LEN * Math.cos(angle);
	drawLine(grid, PIVOT.x, PIVOT.y, ex, ey, ch);
}

function drawCoil(grid: Grid, t: number, energized: boolean): void {
	for (let i = 0; i < 4; i++) {
		const x = COIL_LEFT + i * 4;
		const wave = energized && (Math.floor(t / 110) + i) % 4 < 2;
		const bar = wave ? "═" : "─";
		put(grid, x, COIL_TOP, "╭");
		put(grid, x + 1, COIL_TOP, bar);
		put(grid, x + 2, COIL_TOP, "╮");
		put(grid, x, COIL_TOP + 1, "╰");
		put(grid, x + 1, COIL_TOP + 1, bar);
		put(grid, x + 2, COIL_TOP + 1, "╯");
	}
}

function drawCurrent(grid: Grid, path: Point[], t: number, speed: number, count: number): void {
	for (let k = 0; k < count; k++) {
		const s = (t / speed + k / count) % 1;
		const p = pointAt(path, s);
		put(grid, p.x, p.y, "•");
	}
}

function render(t: number): string {
	const grid = makeGrid();
	const value = armatureValue(t);
	const angle = value * MAX_ANGLE;
	const energized = value > 0.85;

	drawWire(grid, LEFT_PATH);
	drawWire(grid, RIGHT_PATH);
	drawLine(grid, PIVOT.x, PIVOT.y, PIVOT.x, 19);
	drawCoil(grid, t, energized);

	put(grid, LEFT_CONTACT.x, LEFT_CONTACT.y, "●");
	put(grid, RIGHT_CONTACT.x, RIGHT_CONTACT.y, "●");
	putText(grid, LEFT_CONTACT.x - 4, LEFT_CONTACT.y, "NC");
	putText(grid, RIGHT_CONTACT.x + 2, RIGHT_CONTACT.y, "NO");
	putText(grid, 2, COIL_TOP, "coil");
	putText(grid, PIVOT.x + 2, 19, "COM");

	// Motion trail: earlier armature poses fade behind the live one.
	drawArmature(grid, armatureValue(t - 70) * MAX_ANGLE, "·");
	drawArmature(grid, armatureValue(t - 140) * MAX_ANGLE, "·");
	drawArmature(grid, armatureValue(t - 210) * MAX_ANGLE, "·");
	drawArmature(grid, angle);
	put(grid, PIVOT.x, PIVOT.y, "◉");

	if (value < -0.85) drawCurrent(grid, LEFT_PATH, t, 900, 5);
	if (value > 0.85) drawCurrent(grid, RIGHT_PATH, t, 900, 5);
	if (energized) drawCurrent(grid, COIL_PATH, t, 700, 3);

	// A spark where the armature lands on a contact.
	if (Math.abs(value) > 0.95) {
		const contact = value > 0 ? RIGHT_CONTACT : LEFT_CONTACT;
		put(grid, contact.x, contact.y - 1, "*");
		put(grid, contact.x + (value > 0 ? 1 : -1), contact.y, "*");
	}

	return grid.map((row) => row.join("")).join("\n");
}

export function RelayAnimation() {
	const [frame, setFrame] = createSignal(render(0));

	onMount(() => {
		if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
		let raf = 0;
		let last = 0;
		const start = performance.now();
		const tick = (now: number) => {
			if (now - last >= FRAME_MS) {
				last = now;
				setFrame(render(now - start));
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		onCleanup(() => cancelAnimationFrame(raf));
	});

	return (
		<pre class="relay-anim" aria-hidden="true">
			{frame()}
		</pre>
	);
}
