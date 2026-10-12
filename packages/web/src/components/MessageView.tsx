import { Show } from "solid-js";
import type { UIMessage } from "@vvtxn/relay/core/display.ts";
import { Markdown } from "./Markdown.tsx";
import { ToolCalls } from "./ToolCalls.tsx";

/**
 * A single chat turn. Roles are distinguished by a colored left border (user
 * `info`, agent `brand`) instead of terminal glyphs, and turns are separated by
 * the chat gap — no per-message panels. Tool activity is the only element on a
 * background (`surface`), rendered as collapsed per-call rows by `ToolCalls`.
 */
export function MessageView(props: { msg: UIMessage }) {
	const hasText = () => props.msg.content.trim().length > 0;
	const toolCalls = () => props.msg.toolCalls ?? [];

	if (props.msg.role === "user") {
		return (
			<article class="message user">
				<div class="message-body">{props.msg.content}</div>
			</article>
		);
	}

	return (
		<article class="message agent">
			<div class="message-content">
				<Show when={hasText()}>
					<Markdown content={props.msg.content.trim()} />
				</Show>
				<Show when={toolCalls().length > 0}>
					<ToolCalls toolCalls={toolCalls()} />
				</Show>
			</div>
		</article>
	);
}
