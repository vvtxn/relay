// Padding resolution tests for the shared box padding helper: per-edge
// precedence (explicit side > axis shorthand > all-edge), the extra ring a
// border reserves, and ScrollArea's scrollbar gutter.

import { describe, expect, it } from "vite-plus/test";
import Y, { type Node as YogaNode } from "yoga-layout";
import { applyBoxPadding } from "../tui/render/elements/padding.ts";
import { ScrollAreaLayout } from "../tui/render/elements/scroll-area.ts";
import type { ScrollAreaInstance } from "../tui/render/types/index.ts";

function edges(node: YogaNode) {
	return {
		top: node.getPadding(Y.EDGE_TOP).value,
		right: node.getPadding(Y.EDGE_RIGHT).value,
		bottom: node.getPadding(Y.EDGE_BOTTOM).value,
		left: node.getPadding(Y.EDGE_LEFT).value,
	};
}

describe("applyBoxPadding", () => {
	it("resolves each edge: explicit side > axis shorthand > all-edge", () => {
		const node = Y.Node.create();
		applyBoxPadding(node, { padding: 2, paddingX: 1, paddingLeft: 3 });
		expect(edges(node)).toEqual({ top: 2, right: 1, bottom: 2, left: 3 });
		node.free();
	});

	it("adds extra cells (a border ring) on top of every edge", () => {
		const node = Y.Node.create();
		applyBoxPadding(node, { paddingX: 1, paddingY: 1 }, 1);
		expect(edges(node)).toEqual({ top: 2, right: 2, bottom: 2, left: 2 });
		node.free();
	});
});

describe("ScrollAreaLayout", () => {
	function layout(props: ScrollAreaInstance["props"]) {
		const node = Y.Node.create();
		const instance = {
			type: "scrollArea",
			props,
			children: [],
			yogaNode: node,
		} as unknown as ScrollAreaInstance;
		ScrollAreaLayout(instance);
		const result = edges(node);
		node.free();
		return result;
	}

	it("honors per-edge padding like Box", () => {
		expect(layout({ paddingX: 2, paddingY: 1 })).toEqual({ top: 1, right: 2, bottom: 1, left: 2 });
	});

	it("reserves the scrollbar gutter beyond the resolved right padding", () => {
		expect(layout({ paddingX: 2, paddingY: 1, scrollbar: true })).toEqual({ top: 1, right: 3, bottom: 1, left: 2 });
	});
});
