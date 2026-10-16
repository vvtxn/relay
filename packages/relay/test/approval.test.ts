// Tests for withApproval: readonly and workspace-confined tools skip the
// prompt by default; everything else is gated.

import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { withApproval } from "../core/tools/approval.ts";
import type { Tool } from "../core/tools/types.ts";

function tool(name: string, flags: { readonly?: boolean; confined?: boolean } = {}): Tool {
	return {
		definition: { type: "function", function: { name, description: name, parameters: { type: "object" } } },
		...(flags.readonly ? { readonly: true } : {}),
		...(flags.confined ? { confined: true } : {}),
		execute: () => Effect.succeed({ content: `${name} ran` }),
	};
}

describe("withApproval", () => {
	it("skips readonly and confined tools and gates the rest", async () => {
		const asked: string[] = [];
		const [read, write, bash] = withApproval(
			[tool("read_file", { readonly: true }), tool("write_file", { confined: true }), tool("bash")],
			(candidate) => {
				asked.push(candidate.definition.function.name);
				return Effect.succeed(false);
			},
		);

		const readResult = await Effect.runPromise(read!.execute({}));
		const writeResult = await Effect.runPromise(write!.execute({}));
		const bashResult = await Effect.runPromise(bash!.execute({}));

		expect(asked).toEqual(["bash"]);
		expect(readResult.isError).not.toBe(true);
		expect(writeResult.isError).not.toBe(true);
		expect(bashResult.isError).toBe(true);
		expect(bashResult.content).toContain("denied");
	});

	it("gates confined tools when skipConfined is false", async () => {
		const asked: string[] = [];
		const [write] = withApproval(
			[tool("write_file", { confined: true })],
			(candidate) => {
				asked.push(candidate.definition.function.name);
				return Effect.succeed(true);
			},
			{ skipConfined: false },
		);

		const result = await Effect.runPromise(write!.execute({}));

		expect(asked).toEqual(["write_file"]);
		expect(result.content).toContain("ran");
	});

	it("gates readonly tools when skipReadonly is false", async () => {
		const asked: string[] = [];
		const [read] = withApproval(
			[tool("read_file", { readonly: true })],
			() => {
				asked.push("asked");
				return Effect.succeed(true);
			},
			{ skipReadonly: false },
		);

		await Effect.runPromise(read!.execute({}));

		expect(asked).toEqual(["asked"]);
	});
});
