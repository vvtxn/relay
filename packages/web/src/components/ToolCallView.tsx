import { getToolDisplayName, getToolDisplayOutput, type UIToolCall } from "@vvtxn/relay/core/display.ts";
import { DiffView } from "./DiffView.tsx";

export function ToolCallView({ tool }: { tool: UIToolCall }) {
	const output = getToolDisplayOutput(tool);
	const running = !tool.output;

	return (
		<div class={`tool-call ${running ? "running" : "done"}`}>
			<div class="tool-head">
				<span class="tool-name">{getToolDisplayName(tool.name)}</span>
				<span class="tool-input">{tool.input}</span>
			</div>
			{output && <div class="tool-output">{output.trim()}</div>}
			{tool.diff && <DiffView diff={tool.diff} />}
		</div>
	);
}
