import type { UIMessage } from "@vvtxn/relay/core/display.ts";
import { Markdown } from "./Markdown.tsx";
import { ToolCallView } from "./ToolCallView.tsx";

export function MessageView({ msg }: { msg: UIMessage }) {
	if (msg.role === "user") {
		return (
			<div class="message user">
				<div class="bubble">{msg.content}</div>
			</div>
		);
	}

	return (
		<div class="message agent">
			{(msg.toolCalls ?? []).map((tc, i) => <ToolCallView key={i} tool={tc} />)}
			{msg.content.trim() && <Markdown text={msg.content} />}
		</div>
	);
}
