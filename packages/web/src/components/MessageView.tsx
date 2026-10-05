import { For, Show } from "solid-js";
import type { UIMessage } from "@vvtxn/relay/core/display.ts";
import { Markdown } from "./Markdown.tsx";
import { ToolCallView } from "./ToolCallView.tsx";

export function MessageView(props: {
	msg: UIMessage;
	userName?: string | undefined;
	avatarUrl?: string | undefined;
}) {
	const hasText = () => props.msg.content.trim().length > 0;
	const toolCalls = () => props.msg.toolCalls ?? [];

	if (props.msg.role === "user") {
		return (
			<article class="message user">
				<header class="message-head">
					<Show when={props.avatarUrl}>
						<img class="avatar" src={props.avatarUrl} alt="" />
					</Show>
					<span class="message-role">{props.userName ?? "You"}</span>
				</header>
				<div class="message-body">{props.msg.content}</div>
			</article>
		);
	}

	return (
		<article class="message agent">
			<header class="message-head">
				<span class="message-role">Agent</span>
			</header>
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
		</article>
	);
}
