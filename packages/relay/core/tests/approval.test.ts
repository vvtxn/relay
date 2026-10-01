import { assert, assertEquals } from "@std/assert";
import { withApproval } from "@/core/tools/approval.ts";
import { defineTool, type Tool } from "@/core/tools/types.ts";

function makeTool(name: string, readonly = false): { tool: Tool; calls: unknown[] } {
	const calls: unknown[] = [];
	const tool = defineTool({
		name,
		description: `Mock tool ${name}`,
		parameters: { type: "object" },
		readonly,
		execute: (input) => {
			calls.push(input);
			return Promise.resolve({ content: `ran ${name}` });
		},
	});
	return { tool, calls };
}

Deno.test("withApproval executes the tool when approved", async () => {
	const { tool, calls } = makeTool("write_file");
	const wrapped = withApproval([tool], () => Promise.resolve(true))[0]!;

	const result = await wrapped.execute({ path: "a.txt" });

	assertEquals(result.isError, undefined);
	assertEquals(result.content, "ran write_file");
	assertEquals(calls.length, 1);
});

Deno.test("withApproval returns an error result without executing when denied", async () => {
	const { tool, calls } = makeTool("bash");
	const wrapped = withApproval([tool], () => Promise.resolve(false))[0]!;

	const result = await wrapped.execute({ command: "rm -rf /" });

	assertEquals(result.isError, true);
	assert(result.content.includes("denied"));
	assertEquals(calls.length, 0, "denied tool must not execute");
});

Deno.test("withApproval passes the tool and input to the handler", async () => {
	const { tool } = makeTool("bash");
	let seenName = "";
	let seenInput: unknown;
	const wrapped = withApproval([tool], (t, input) => {
		seenName = t.definition.function.name;
		seenInput = input;
		return Promise.resolve(true);
	})[0]!;

	await wrapped.execute({ command: "ls" });

	assertEquals(seenName, "bash");
	assertEquals(seenInput, { command: "ls" });
});

Deno.test("withApproval skips readonly tools by default", async () => {
	const { tool } = makeTool("read_file", true);
	let handlerCalls = 0;
	const wrapped = withApproval([tool], () => {
		handlerCalls++;
		return Promise.resolve(false);
	})[0]!;

	const result = await wrapped.execute({ path: "a.txt" });

	assertEquals(handlerCalls, 0, "handler should not be consulted for readonly tools");
	assertEquals(result.content, "ran read_file");
});

Deno.test("withApproval gates readonly tools when skipReadonly is false", async () => {
	const { tool, calls } = makeTool("read_file", true);
	const wrapped = withApproval([tool], () => Promise.resolve(false), { skipReadonly: false })[0]!;

	const result = await wrapped.execute({ path: "a.txt" });

	assertEquals(result.isError, true);
	assertEquals(calls.length, 0);
});

Deno.test("withApproval preserves tool definitions and readonly flags", () => {
	const { tool } = makeTool("grep", true);
	const wrapped = withApproval([tool], () => Promise.resolve(true))[0]!;

	assertEquals(wrapped.definition, tool.definition);
	assertEquals(wrapped.readonly, true);
});
