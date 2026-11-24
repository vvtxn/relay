import { onCleanup, onMount } from "solid-js";

/**
 * A vector signal orb: a slowly rotating sphere of nodes whose brightness and
 * radius are driven by waves of current sweeping across the surface. Drawn on
 * a HiDPI canvas with the active theme tokens, so it tracks the palette; the
 * whole thing is decorative, hidden from assistive tech, and rests on a single
 * frame under reduced motion.
 */

const DOT_COUNT = 820;
const FRAME_MS = 1000 / 30;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const RESTING_CLOCK = 1.45;

type Rgb = readonly [number, number, number];

interface Dot {
	/** Unit-sphere coordinates. */
	x: number;
	y: number;
	z: number;
	/** Polar angle from the north pole, used for the traveling wave. */
	polar: number;
	/** Azimuth around the sphere, used for the secondary shimmer. */
	azimuth: number;
}

interface Palette {
	dim: Rgb;
	brand: Rgb;
	accent: Rgb;
}

const FALLBACK: Palette = {
	dim: [0x80, 0x80, 0x80],
	brand: [0xc0, 0xc0, 0xc0],
	accent: [0x8f, 0xd0, 0xd8],
};

function buildSphere(count: number): Dot[] {
	const dots: Dot[] = [];
	for (let i = 0; i < count; i++) {
		const y = 1 - (i / (count - 1)) * 2;
		const radius = Math.sqrt(Math.max(0, 1 - y * y));
		const azimuth = i * GOLDEN_ANGLE;
		dots.push({
			x: Math.cos(azimuth) * radius,
			y,
			z: Math.sin(azimuth) * radius,
			polar: Math.acos(Math.max(-1, Math.min(1, y))),
			azimuth,
		});
	}
	return dots;
}

function parseHex(value: string, fallback: Rgb): Rgb {
	const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
	if (!match) return fallback;
	const n = Number.parseInt(match[1] ?? "", 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function readPalette(element: Element): Palette {
	const style = globalThis.getComputedStyle(element);
	const read = (name: string, fallback: Rgb): Rgb => parseHex(style.getPropertyValue(name), fallback);
	return {
		dim: read("--relay-text-dim", FALLBACK.dim),
		brand: read("--relay-brand", FALLBACK.brand),
		accent: read("--relay-mention", FALLBACK.accent),
	};
}

function mix(from: Rgb, to: Rgb, t: number): Rgb {
	const f = Math.max(0, Math.min(1, t));
	return [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f, from[2] + (to[2] - from[2]) * f];
}

function css(color: Rgb, alpha: number): string {
	const a = Math.max(0, Math.min(1, alpha));
	return `rgba(${Math.round(color[0])}, ${Math.round(color[1])}, ${Math.round(color[2])}, ${a.toFixed(3)})`;
}

function draw(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	clock: number,
	dots: Dot[],
	palette: Palette,
) {
	ctx.clearRect(0, 0, width, height);

	const cx = width / 2;
	const cy = height / 2;
	const radius = Math.min(width, height) * 0.435;

	const halo = ctx.createRadialGradient(cx, cy, radius * 0.15, cx, cy, radius * 1.2);
	halo.addColorStop(0, css(palette.brand, 0.07));
	halo.addColorStop(0.65, css(palette.brand, 0.025));
	halo.addColorStop(1, css(palette.brand, 0));
	ctx.fillStyle = halo;
	ctx.fillRect(0, 0, width, height);

	const spin = clock * 0.26;
	const cosY = Math.cos(spin);
	const sinY = Math.sin(spin);
	const tilt = -0.38 + Math.sin(clock * 0.21) * 0.06;
	const cosX = Math.cos(tilt);
	const sinX = Math.sin(tilt);

	// Luminescence is bucketed so identical dots share one fill-style string.
	const styles = new Map<number, { fill: string; glow: string }>();
	const styleFor = (lum: number) => {
		const key = Math.round(lum * 24);
		let style = styles.get(key);
		if (!style) {
			const bucket = key / 24;
			let color = mix(palette.dim, palette.brand, Math.min(1, bucket * 1.5));
			if (bucket > 0.72) color = mix(color, palette.accent, ((bucket - 0.72) / 0.28) * 0.55);
			style = {
				fill: css(color, 0.4 + 0.6 * bucket),
				glow: css(color, Math.max(0, (bucket - 0.78) * 0.32)),
			};
			styles.set(key, style);
		}
		return style;
	};

	for (const dot of dots) {
		// Rotate around the vertical axis, then tilt slightly on X.
		const x1 = dot.x * cosY + dot.z * sinY;
		const z1 = -dot.x * sinY + dot.z * cosY;
		const y1 = dot.y;
		const y2 = y1 * cosX - z1 * sinX;
		const z2 = y1 * sinX + z1 * cosX;

		const depth = (z2 + 1) / 2;
		const px = cx + x1 * radius;
		const py = cy + y2 * radius;

		// A band of current travels from pole to pole while a slower ripple
		// rolls around the equator; depth fades the far hemisphere.
		const wave =
			0.5 + 0.5 * Math.sin(dot.polar * 2.6 - clock * 1.5 + Math.sin(dot.azimuth * 2 + clock * 0.6) * 0.8);
		const ripple = 0.5 + 0.5 * Math.sin(dot.azimuth * 3 - clock * 1.1 + dot.polar * 1.6);
		const energy = 0.46 + 0.54 * wave ** 1.1 * (0.7 + 0.3 * ripple);
		const lum = energy * (0.42 + 0.58 * depth);
		const dotRadius = 1 + 2 * lum * (0.6 + 0.4 * depth);
		const style = styleFor(lum);

		ctx.beginPath();
		ctx.arc(px, py, dotRadius, 0, Math.PI * 2);
		ctx.fillStyle = style.fill;
		ctx.fill();

		// The brightest nodes get a soft bloom.
		if (lum > 0.78) {
			ctx.beginPath();
			ctx.arc(px, py, dotRadius * 3.1, 0, Math.PI * 2);
			ctx.fillStyle = style.glow;
			ctx.fill();
		}
	}
}

export function RelayAnimation() {
	let canvas: HTMLCanvasElement | undefined;

	onMount(() => {
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const dots = buildSphere(DOT_COUNT);
		let palette = readPalette(canvas);
		let width = 0;
		let height = 0;
		let raf = 0;
		let last = 0;
		const start = performance.now();
		const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

		const paint = (clock: number) => {
			if (width <= 0 || height <= 0) return;
			draw(ctx, width, height, clock, dots, palette);
		};

		const resize = () => {
			if (!canvas) return;
			const rect = canvas.getBoundingClientRect();
			const dpr = Math.min(globalThis.devicePixelRatio || 1, 2.5);
			width = Math.max(1, rect.width);
			height = Math.max(1, rect.height);
			canvas.width = Math.round(width * dpr);
			canvas.height = Math.round(height * dpr);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			paint(reduced ? RESTING_CLOCK : (performance.now() - start) / 1000);
		};

		resize();
		const resizeObserver = new ResizeObserver(resize);
		resizeObserver.observe(canvas);

		// The palette is applied as CSS variables + `data-theme` on the root.
		const themeObserver = new MutationObserver(() => {
			palette = readPalette(canvas ?? document.documentElement);
			paint(reduced ? RESTING_CLOCK : (performance.now() - start) / 1000);
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme", "class", "style"],
		});

		if (!reduced) {
			const tick = (now: number) => {
				if (now - last >= FRAME_MS) {
					last = now;
					paint((now - start) / 1000);
				}
				raf = requestAnimationFrame(tick);
			};
			raf = requestAnimationFrame(tick);
		}

		onCleanup(() => {
			cancelAnimationFrame(raf);
			resizeObserver.disconnect();
			themeObserver.disconnect();
		});
	});

	return <canvas ref={canvas} class="relay-orb" aria-hidden="true" />;
}
