import { assertEquals } from "@std/assert";
import {
	applyServerEvent,
	flushDraft,
	initialSessionStreamState,
	type SessionStreamState,
	viewMessages,
} from "./session-state.ts";
import type { ServerEvent } from "./protocol.ts";

function fold(events: ServerEvent[], state: SessionStreamState = initialSessionStreamState): SessionStreamState {
	return events.reduce((acc, event) => applyServerEvent(acc, event), state);
}

Deno.test("session-state - text deltas accumulate in the draft", () => {
	const state = fold([
		{ type: "text_delta", content: "Hel" },
		{ type: "text_delta", content: "lo" },
	]);
	assertEquals(state.draftText, "Hello");
	assertEquals(state.status, { kind: "writing" });
	assertEquals(viewMessages(state), [{ role: "agent", content: "Hello", toolCalls: [] }]);
	assertEquals(state.messages, []);
});

Deno.test("session-state - turn_complete flushes the draft into messages", () => {
	const state = fold([
		{ type: "text_delta", content: "done" },
		{ type: "turn_complete" },
	]);
	assertEquals(state.messages, [{ role: "agent", content: "done", toolCalls: [] }]);
	assertEquals(state.draftText, "");
	assertEquals(viewMessages(state), state.messages);
});

Deno.test("session-state - run_state snapshots draft text, tool calls, and totals", () => {
	const state = applyServerEvent(initialSessionStreamState, {
		type: "run_state",
		draftText: "partial",
		toolCalls: [
			{ id: "t1", name: "bash", args: '{"command":"ls"}', result: { content: "a\nb" } },
			{ id: "t2", name: "read_file", args: '{"path":"x.ts"}' },
		],
		pendingApproval: null,
		tokens: 42,
		cost: 0.01,
	});
	assertEquals(state.draftText, "partial");
	assertEquals(state.running, true);
	assertEquals(state.tokens, 42);
	assertEquals(state.cost, 0.01);
	assertEquals(state.draftToolCalls.length, 2);
	assertEquals(state.draftToolCalls[0], { name: "bash", input: "ls", output: "a\nb" });
	assertEquals(state.toolCallIndex, { t1: 0, t2: 1 });
});

Deno.test("session-state - tool_call_end and tool_result attach output and diff", () => {
	const state = fold([
		{ type: "tool_call_start", id: "t1", name: "edit_file" },
		{ type: "tool_call_end", id: "t1", name: "edit_file", args: '{"path":"a.ts"}' },
		{
			type: "tool_result",
			id: "t1",
			result: { content: "ok", meta: { diff: "@@ -1 +1 @@\n-old\n+new" } },
		},
	]);
	assertEquals(state.draftToolCalls.length, 1);
	assertEquals(state.draftToolCalls[0]!.input, "a.ts");
	assertEquals(state.draftToolCalls[0]!.output, "ok");
	assertEquals(state.draftToolCalls[0]!.diff, "@@ -1 +1 @@\n-old\n+new");
});

Deno.test("session-state - tool_result for an unknown id is ignored", () => {
	const state = applyServerEvent(initialSessionStreamState, {
		type: "tool_result",
		id: "missing",
		result: { content: "x" },
	});
	assertEquals(state, initialSessionStreamState);
});

Deno.test("session-state - approval lifecycle", () => {
	const pending = { toolCallId: "t1", toolName: "bash", summary: "rm -rf" };
	const asked = applyServerEvent(initialSessionStreamState, { type: "approval_required", approval: pending });
	assertEquals(asked.pendingApproval, pending);

	const otherResolved = applyServerEvent(asked, { type: "approval_resolved", toolCallId: "nope", decision: "deny" });
	assertEquals(otherResolved.pendingApproval, pending);

	const resolved = applyServerEvent(asked, { type: "approval_resolved", toolCallId: "t1", decision: "allow" });
	assertEquals(resolved.pendingApproval, null);
});

Deno.test("session-state - run_finished flushes, stops running, and clears approval", () => {
	const state = fold([
		{ type: "text_delta", content: "bye" },
		{ type: "approval_required", approval: { toolCallId: "t1", toolName: "bash", summary: "x" } },
		{ type: "run_finished", reason: "completed" },
	]);
	assertEquals(state.running, false);
	assertEquals(state.pendingApproval, null);
	assertEquals(state.messages, [{ role: "agent", content: "bye", toolCalls: [] }]);
});

Deno.test("session-state - error appends an agent error message", () => {
	const state = applyServerEvent(initialSessionStreamState, { type: "error", message: "boom" });
	assertEquals(state.messages, [{ role: "agent", content: "**Error:** boom" }]);
});

Deno.test("session-state - flushDraft is a no-op when the draft is empty", () => {
	assertEquals(flushDraft(initialSessionStreamState), initialSessionStreamState);
});
