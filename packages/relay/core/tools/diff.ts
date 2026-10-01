/**
 * Generate a unified diff between two strings.
 *
 * Pure-TypeScript Myers diff with common prefix/suffix stripping
 * and minimal allocations. Returns synchronously.
 */
export function generateDiff(
	oldText: string,
	newText: string,
): string | undefined {
	if (oldText === newText) return undefined;

	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");

	// Strip common prefix and suffix to shrink the diff problem
	let prefix = 0;
	const minLen = Math.min(oldLines.length, newLines.length);
	while (prefix < minLen && oldLines[prefix] === newLines[prefix]) prefix++;

	let suffix = 0;
	while (
		suffix < minLen - prefix &&
		oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
	) suffix++;

	const oldSlice = oldLines.slice(prefix, oldLines.length - suffix);
	const newSlice = newLines.slice(prefix, newLines.length - suffix);

	if (oldSlice.length === 0 && newSlice.length === 0) return undefined;

	const edits = myersDiff(oldSlice, newSlice);
	const hunks = buildHunks(edits, oldSlice, newSlice, prefix, 3);
	if (hunks.length === 0) return undefined;

	return "--- a\n+++ b\n" + hunks.join("\n");
}

// ---------------------------------------------------------------------------
// Myers diff – returns a flat array of edit ops encoded as numbers
// ---------------------------------------------------------------------------
// Encoding: positive = equal (1-indexed old line), negative = change marker
// We use a simpler approach: produce an array of ops where:
//   0  = equal
//   1  = delete
//   2  = insert

const EQUAL = 0;
const DELETE = 1;
const INSERT = 2;

function myersDiff(a: string[], b: string[]): Uint8Array {
	const n = a.length;
	const m = b.length;

	if (n === 0) {
		const ops = new Uint8Array(m);
		ops.fill(INSERT);
		return ops;
	}
	if (m === 0) {
		const ops = new Uint8Array(n);
		ops.fill(DELETE);
		return ops;
	}

	const max = n + m;
	const vLen = 2 * max + 1;
	const v = new Int32Array(vLen);
	// Store trace as flat buffer: each d-step stores (2*d+1) values centered on offset
	// But for simplicity and speed, store full v snapshots only when d is small,
	// otherwise use a compact trace.
	const trace: Int32Array[] = [];

	const off = max;
	v[1 + off] = 0;

	let finalD = 0;
	outer:
	for (let d = 0; d <= max; d++) {
		trace.push(v.slice()); // snapshot
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && v[k - 1 + off]! < v[k + 1 + off]!)) {
				x = v[k + 1 + off]!;
			} else {
				x = v[k - 1 + off]! + 1;
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[k + off] = x;
			if (x >= n && y >= m) {
				finalD = d;
				break outer;
			}
		}
	}

	// Backtrack
	const ops: number[] = [];
	let x = n;
	let y = m;

	for (let d = finalD; d >= 0; d--) {
		const snap = trace[d]!;
		const k = x - y;
		let prevK: number;
		if (k === -d || (k !== d && snap[k - 1 + off]! < snap[k + 1 + off]!)) {
			prevK = k + 1;
		} else {
			prevK = k - 1;
		}
		const prevX = snap[prevK + off]!;
		const prevY = prevX - prevK;

		while (x > prevX && y > prevY) {
			ops.push(EQUAL);
			x--;
			y--;
		}
		if (d > 0) {
			ops.push(x === prevX ? INSERT : DELETE);
			if (x === prevX) y--;
			else x--;
		}
	}

	ops.reverse();
	return new Uint8Array(ops);
}

// ---------------------------------------------------------------------------
// Hunk building — directly from ops array
// ---------------------------------------------------------------------------

function buildHunks(
	ops: Uint8Array,
	oldSlice: string[],
	newSlice: string[],
	prefixLen: number,
	ctx: number,
): string[] {
	// Walk ops to find change regions, then group with context
	const changeIdxs: number[] = [];
	for (let i = 0; i < ops.length; i++) {
		if (ops[i] !== EQUAL) changeIdxs.push(i);
	}
	if (changeIdxs.length === 0) return [];

	// Group changes separated by <= 2*ctx equal ops
	const groups: [number, number][] = [];
	let gStart = 0;
	for (let i = 1; i < changeIdxs.length; i++) {
		if (changeIdxs[i]! - changeIdxs[i - 1]! > ctx * 2 + 1) {
			groups.push([changeIdxs[gStart]!, changeIdxs[i - 1]!]);
			gStart = i;
		}
	}
	groups.push([changeIdxs[gStart]!, changeIdxs[changeIdxs.length - 1]!]);

	// Build old/new index mapping along ops
	// Pre-compute cumulative old/new indices for each op position
	const oldIdx = new Int32Array(ops.length);
	const newIdx = new Int32Array(ops.length);
	let oi = 0, ni = 0;
	for (let i = 0; i < ops.length; i++) {
		oldIdx[i] = oi;
		newIdx[i] = ni;
		if (ops[i] === EQUAL) {
			oi++;
			ni++;
		} else if (ops[i] === DELETE) oi++;
		else ni++;
	}

	const hunks: string[] = [];

	for (const [first, last] of groups) {
		const start = Math.max(0, first - ctx);
		const end = Math.min(ops.length - 1, last + ctx);

		const lines: string[] = [];
		let oCount = 0;
		let nCount = 0;

		for (let i = start; i <= end; i++) {
			if (ops[i] === EQUAL) {
				lines.push(` ${oldSlice[oldIdx[i]!]!}`);
				oCount++;
				nCount++;
			} else if (ops[i] === DELETE) {
				lines.push(`-${oldSlice[oldIdx[i]!]!}`);
				oCount++;
			} else {
				lines.push(`+${newSlice[newIdx[i]!]!}`);
				nCount++;
			}
		}

		const oStart = oldIdx[start]! + prefixLen + 1;
		const nStart = newIdx[start]! + prefixLen + 1;
		hunks.push(`@@ -${oStart},${oCount} +${nStart},${nCount} @@\n${lines.join("\n")}`);
	}

	return hunks;
}
