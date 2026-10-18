// Geometry tests for the box surface primitives. Background fills span the
// box edge to edge (clipped to the border interior when one is present), and
// a border sits on the backdrop *behind* the box — never on its own surface —
// so the fill cannot bleed outside the outline at rounded corners.

import { describe, expect, it } from "vite-plus/test";
import Y from "yoga-layout";
import { bgRgb, fgRgb, RESET_BG } from "../tui/core/ansi.ts";
import { borderPositions, fillPositions } from "../tui/core/primitives/fill.ts";
import { BoxElement } from "../tui/render/elements/box.ts";
import type { BoxInstance, RenderContext } from "../tui/render/types/index.ts";

const FG = fgRgb(0x30, 0x30, 0x30);
const LABEL_FG = fgRgb(0x80, 0x80, 0x80);
const SURFACE = bgRgb(0x10, 0x10, 0x10);
const OUTER = bgRgb(0x0a, 0x0a, 0x0a);

describe("fillPositions", () => {
	it("fills every row edge to edge and resets the background", () => {
		expect(fillPositions(1, 2, 3, 2, SURFACE)).toEqual([
			{ x: 1, y: 2, text: `${SURFACE}   ${RESET_BG}` },
			{ x: 1, y: 3, text: `${SURFACE}   ${RESET_BG}` },
		]);
	});
});

describe("borderPositions", () => {
	it("draws rounded top and bottom edges on the outer background", () => {
		const positions = borderPositions(2, 3, 6, 4, FG, OUTER, true);
		expect(positions[0]).toEqual({ x: 2, y: 3, text: `${OUTER}${FG}╭────╮` });
		expect(positions[1]).toEqual({ x: 2, y: 6, text: `${OUTER}${FG}╰────╯` });
	});

	it("draws square corners when not rounded", () => {
		const positions = borderPositions(0, 0, 4, 2, FG, OUTER, false);
		expect(positions[0]?.text).toBe(`${OUTER}${FG}┌──┐`);
		expect(positions[1]?.text).toBe(`${OUTER}${FG}└──┘`);
	});

	it("draws side glyphs on the interior rows", () => {
		const positions = borderPositions(5, 1, 5, 4, FG, null, false);
		expect(positions.slice(2)).toEqual([
			{ x: 5, y: 2, text: `${FG}│` },
			{ x: 9, y: 2, text: `${FG}│` },
			{ x: 5, y: 3, text: `${FG}│` },
			{ x: 9, y: 3, text: `${FG}│` },
		]);
	});

	it("renders no border for boxes smaller than 2x2", () => {
		expect(borderPositions(0, 0, 1, 4, FG, OUTER, true)).toEqual([]);
		expect(borderPositions(0, 0, 4, 1, FG, OUTER, true)).toEqual([]);
	});
});

describe("borderPositions labels", () => {
	it("embeds a colored label after the leading dash, then dashes to the corner", () => {
		const positions = borderPositions(2, 3, 16, 4, FG, OUTER, true, { text: "INSERT", fgAnsi: LABEL_FG });
		expect(positions[0]).toEqual({
			x: 2,
			y: 3,
			text: `${OUTER}${FG}╭─${OUTER}${LABEL_FG} INSERT ${OUTER}${FG}─────╮`,
		});
		// The rest of the outline is unaffected.
		expect(positions[1]).toEqual({ x: 2, y: 6, text: `${OUTER}${FG}╰──────────────╯` });
	});

	it("keeps the border foreground when the label has no color of its own", () => {
		const positions = borderPositions(0, 0, 11, 2, FG, OUTER, true, { text: "NORMAL" });
		expect(positions[0]?.text).toBe(`${OUTER}${FG}╭─ NORMAL ${OUTER}${FG}╮`);
	});

	it("clips an overlong label to the cells between the corners", () => {
		const positions = borderPositions(0, 0, 10, 2, FG, OUTER, true, { text: "INSERT", fgAnsi: LABEL_FG });
		expect(positions[0]?.text).toBe(`${OUTER}${FG}╭─${OUTER}${LABEL_FG} INSER ${OUTER}${FG}╮`);
	});

	it("ignores labels that cannot fit a corner and one label cell", () => {
		const positions = borderPositions(0, 0, 5, 2, FG, OUTER, true, { text: "INSERT", fgAnsi: LABEL_FG });
		expect(positions[0]?.text).toBe(`${OUTER}${FG}╭───╮`);
	});
});

describe("BoxElement", () => {
	function renderBox(props: BoxInstance["props"], w: number, h: number, inheritedBg: string | null) {
		const node = Y.Node.create();
		node.setWidth(w);
		node.setHeight(h);
		node.calculateLayout(w, h, Y.DIRECTION_LTR);
		const instance = {
			type: "box",
			props,
			children: [],
			yogaNode: node,
		} as unknown as BoxInstance;
		const context: RenderContext = { parentX: 0, parentY: 0, inheritedBg, renderInstance: () => [] };
		const positions = BoxElement(instance, context);
		node.free();
		return positions;
	}

	it("clips the fill to the border interior while the ring shows the backdrop", () => {
		const positions = renderBox({ bgColor: "#101010", borderColor: "#303030", borderRadius: true }, 6, 4, OUTER);

		// The surface fills only the interior (one-cell inset)…
		expect(positions.filter((p) => p.text.startsWith(SURFACE))).toEqual([
			{ x: 1, y: 1, text: `${SURFACE}    ${RESET_BG}` },
			{ x: 1, y: 2, text: `${SURFACE}    ${RESET_BG}` },
		]);
		// …and the border ring shows the backdrop behind the box with rounded corners.
		expect(positions[2]).toEqual({ x: 0, y: 0, text: `${OUTER}${FG}╭────╮` });
	});

	it("fills the whole box when no border is set", () => {
		const positions = renderBox({ bgColor: "#101010" }, 4, 2, OUTER);
		expect(positions).toEqual([
			{ x: 0, y: 0, text: `${SURFACE}    ${RESET_BG}` },
			{ x: 0, y: 1, text: `${SURFACE}    ${RESET_BG}` },
		]);
	});

	it("paints borderLabel on the top edge in its own color", () => {
		const positions = renderBox(
			{ borderColor: "#303030", borderRadius: true, borderLabel: "INSERT", borderLabelColor: "#808080" },
			20,
			4,
			OUTER,
		);
		expect(positions[0]).toEqual({
			x: 0,
			y: 0,
			text: `${OUTER}${FG}╭─${OUTER}${LABEL_FG} INSERT ${OUTER}${FG}─────────╮`,
		});
	});
});
