// Workspace URL tokens: round-trips stay exact for arbitrary filesystem paths
// and invalid input decodes to null instead of throwing.

import { describe, expect, it } from "vite-plus/test";
import { decodeWorkspaceToken, encodeWorkspaceToken } from "../core/workspace-token.ts";

const PATHS = [
	"/",
	"/home/me/project",
	"/home/me/project with spaces",
	"/home/me/projé ts/δ",
	"/Users/me/Code/weird~chars&?name",
	"C:\\Users\\me\\project",
];

describe("workspace tokens", () => {
	it("round-trips arbitrary paths", () => {
		for (const path of PATHS) {
			expect(decodeWorkspaceToken(encodeWorkspaceToken(path))).toBe(path);
		}
	});

	it("produces a URL-safe single segment with no padding", () => {
		for (const path of PATHS) {
			expect(encodeWorkspaceToken(path)).toMatch(/^[A-Za-z0-9_-]+$/);
		}
	});

	it("returns null for malformed tokens", () => {
		for (const token of ["", "abc!", "%2Fhome", "====", "a b", "/"]) {
			expect(decodeWorkspaceToken(token)).toBeNull();
		}
	});
});
