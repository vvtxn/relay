import { For, Show } from "solid-js";
import type { UIMessage } from "@vvtxn/relay/core/display.ts";
import { Markdown } from "./Markdown.tsx";
import { ToolCallView } from "./ToolCallView.tsx";

export function MessageView(props: { msg: UIMessage }) {
	if (props.msg.role === "user") {
		return (
			<div class="message user">
				<div class="bubble">{props.msg.content}</div>
			</div>
		);
	}

	const hasText = () => props.msg.content.trim().length > 0;
	const toolCalls = () => props.msg.toolCalls ?? [];

	return (
		<div class="message agent">
			<Show when={hasText()}>
				<div class="agent-text">
					<Markdown content={props.msg.content.trim()} />
				</div>
			</Show>
			<Show when={toolCalls().length > 0}>
				<div class="tool-list">
					<For each={toolCalls()}>{(tool) => <ToolCallView tool={tool} />}</For>
				</div>
			</Show>
		</div>
	);
}
