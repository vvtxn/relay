import { assert, assertEquals } from "@std/assert";
import { font } from "@/core/fonts.ts";

const FONT_ASSET_DIR = new URL("../../assets/fonts/", import.meta.url);

Deno.test("font - css stack names the family and falls back to monospace", () => {
	assert(font.cssStack.includes(`"${font.family}"`));
	assert(font.cssStack.trim().endsWith("monospace"));
});

Deno.test("font - every referenced asset exists and is non-empty", async () => {
	const files = [
		...font.web.map((face) => face.file),
		...font.terminal,
		font.licenseFile,
	];
	assertEquals(new Set(files).size, files.length, "duplicate asset entries");

	for (const file of files) {
		const stat = await Deno.stat(new URL(file, FONT_ASSET_DIR));
		assert(stat.isFile, `${file} is not a file`);
		assert((stat.size ?? 0) > 0, `${file} is empty`);
	}
});

Deno.test("font - web faces cover regular, bold, and italic", () => {
	const faces = new Set(font.web.map((face) => `${face.weight}-${face.style}`));
	assert(faces.has("400-normal"));
	assert(faces.has("700-normal"));
	assert(faces.has("400-italic"));
});
