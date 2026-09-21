import { Show } from "solid-js";
import {
	abbreviateHome,
	getToolDisplayName,
	getToolDisplayOutput,
	type UIToolCall,
} from "@vvtxn/relay/core/display.ts";
import { homeDir } from "@/state/workspace.ts";
import { DiffView } from "./DiffView.tsx";

export function ToolCallView(props: { tool: UIToolCall }) {
	const output = () => getToolDisplayOutput(props.tool);

	return (
		<div class="tool-call">
			<div class="tool-head">
				<span class="tool-name">{getToolDisplayName(props.tool.name)}</span>
				<span class="tool-args">{abbreviateHome(props.tool.input, homeDir())}</span>
			</div>
			<Show when={output()}>
				<pre class="tool-output">{output()!.trim()}</pre>
			</Show>
			<Show when={props.tool.diff}>
				<DiffView diff={props.tool.diff!} />
			</Show>
		</div>
	);
}
