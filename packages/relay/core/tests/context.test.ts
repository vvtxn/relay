import { assertEquals, assertStringIncludes } from "@std/assert";
import { estimateMessageTokens, estimateTokens, trimContext } from "@/core/context.ts";
import type { Message } from "@/api/types.ts";

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

Deno.test("estimateTokens - basic string", () => {
	assertEquals(estimateTokens("hello"), 2); // ceil(5/4) = 2
});

Deno.test("estimateTokens - empty string", () => {
	assertEquals(estimateTokens(""), 0);
});

// ---------------------------------------------------------------------------
// estimateMessageTokens
// ---------------------------------------------------------------------------

Deno.test("estimateMessageTokens - message with content only", () => {
	const msg: Message = { role: "user", content: "hello" };
	// overhead 8 + estimateTokens("hello") = 8 + 2 = 10
	assertEquals(estimateMessageTokens(msg), 10);
});

Deno.test("estimateMessageTokens - message with tool_calls adds name + args tokens", () => {
	const msg: Message = {
		role: "assistant",
		content: null,
		tool_calls: [
			{
				id: "call_1",
				type: "function",
				function: { name: "read_file", arguments: '{"path":"/tmp"}' },
			},
		],
	};
	// overhead 8 + ceil(9/4)=3 + ceil(15/4)=4 = 15
	assertEquals(estimateMessageTokens(msg), 15);
});

// ---------------------------------------------------------------------------
// trimContext — under budget
// ---------------------------------------------------------------------------

Deno.test("trimContext - returns messages unchanged when under budget", () => {
	const messages: Message[] = [
		{ role: "system", content: "You are helpful." },
		{ role: "user", content: "Hi" },
	];
	const result = trimContext(messages, { maxTokens: 100_000 });
	assertEquals(result, messages);
});

// ---------------------------------------------------------------------------
// trimContext — summarization
// ---------------------------------------------------------------------------

Deno.test("trimContext - summarizes old droppable turns into compact format", () => {
	const longContent = "x\ny\nz\n" + "a".repeat(600);
	const messages: Message[] = [
		{ role: "system", content: "sys" },
		{
			role: "assistant",
			content: null,
			tool_calls: [{ id: "c1", type: "function", function: { name: "grep", arguments: "{}" } }],
		},
		{ role: "tool", content: longContent, tool_call_id: "c1", name: "grep" },
		{ role: "user", content: "thanks" },
		{ role: "assistant", content: "done" },
	];

	const result = trimContext(messages, { maxTokens: 100 + 16_000, preserveRecentTurns: 2 });

	// The old assistant+grep turn should be summarized into a [previous turn] message
	const summaryMsg = result.find((m) => m.role === "user" && m.content?.includes("[previous turn]"));
	assertEquals(summaryMsg !== undefined, true);
	assertStringIncludes(summaryMsg!.content!, "Called: grep");
});

// ---------------------------------------------------------------------------
// trimContext — dropping oldest droppable turns
// ---------------------------------------------------------------------------

Deno.test("trimContext - drops oldest droppable turns when still over budget", () => {
	const messages: Message[] = [
		{ role: "system", content: "sys" },
		{ role: "user", content: "old question" },
		{ role: "assistant", content: "old answer" },
		{ role: "user", content: "new question" },
		{ role: "assistant", content: "new answer" },
	];

	// Budget only enough for sys + first user + recent turns
	const result = trimContext(messages, { maxTokens: 42 + 16_000, preserveRecentTurns: 2 });

	assertEquals(result[0]!.role, "system");
	assertEquals(result.some((m) => m.content === "old answer"), false);
	assertEquals(result.some((m) => m.content === "new question"), true);
	assertEquals(result.some((m) => m.content === "new answer"), true);
});

// ---------------------------------------------------------------------------
// trimContext — system messages never dropped
// ---------------------------------------------------------------------------

Deno.test("trimContext - never drops system messages", () => {
	const messages: Message[] = [
		{ role: "system", content: "important system prompt" },
		{ role: "user", content: "q" },
		{ role: "assistant", content: "a" },
	];

	const result = trimContext(messages, { maxTokens: 23 + 16_000, preserveRecentTurns: 1 });

	assertEquals(result.some((m) => m.role === "system" && m.content === "important system prompt"), true);
});

// ---------------------------------------------------------------------------
// trimContext — preserveRecentTurns
// ---------------------------------------------------------------------------

Deno.test("trimContext - preserves recent turns intact, drops old ones", () => {
	const messages: Message[] = [
		{ role: "system", content: "sys" },
		{ role: "user", content: "old q" },
		{ role: "assistant", content: "old reply" },
		{ role: "user", content: "recent1" },
		{ role: "assistant", content: "recent r1" },
		{ role: "user", content: "recent2" },
		{ role: "assistant", content: "recent r2" },
	];

	// Budget allows sys + first user + last 2 turns
	const result = trimContext(messages, { maxTokens: 44 + 16_000, preserveRecentTurns: 2 });

	// System survives
	assertEquals(result[0]!.role, "system");
	// Last 2 turns survive intact
	assertEquals(result.some((m) => m.content === "recent2"), true);
	assertEquals(result.some((m) => m.content === "recent r2"), true);
	// Turns beyond preserve boundary are dropped (after summarization fails to fit)
	assertEquals(result.some((m) => m.content === "recent1"), false);
	assertEquals(result.some((m) => m.content === "recent r1"), false);
});

// ---------------------------------------------------------------------------
// trimContext — assistant + tool messages grouped together
// ---------------------------------------------------------------------------

Deno.test("trimContext - groups assistant + tool messages together when dropping", () => {
	const messages: Message[] = [
		{ role: "system", content: "sys" },
		{
			role: "assistant",
			content: null,
			tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
		},
		{ role: "tool", content: "file1\nfile2", tool_call_id: "c1", name: "bash" },
		{ role: "user", content: "latest" },
		{ role: "assistant", content: "final" },
	];

	const result = trimContext(messages, { maxTokens: 30 + 16_000, preserveRecentTurns: 2 });

	// The assistant+tool group should be dropped together
	assertEquals(result.some((m) => m.role === "tool" && m.tool_call_id === "c1"), false);
	assertEquals(result.some((m) => m.tool_calls?.some((tc) => tc.id === "c1")), false);
	// Recent turns kept
	assertEquals(result.some((m) => m.content === "latest"), true);
	assertEquals(result.some((m) => m.content === "final"), true);
});
