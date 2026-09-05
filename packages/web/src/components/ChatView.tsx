import { useEffect, useRef } from "preact/hooks";
import type { UIMessage, UIToolCall } from "@vvtxn/relay/core/display.ts";
import { MessageView } from "./MessageView.tsx";
import { ToolCallView } from "./ToolCallView.tsx";
import { Markdown } from "./Markdown.tsx";

interface ChatViewProps {
	messages: UIMessage[];
	streaming: boolean;
	draftText: string;
	draftToolCalls: UIToolCall[];
	statusText: string;
}

export function ChatView({ messages, streaming, draftText, draftToolCalls, statusText }: ChatViewProps) {
	const bottomRef = useRef<HTMLDivElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);

	// Auto-scroll only when the user is already near the bottom
	useEffect(() => {
		const scroll = scrollRef.current;
		if (!scroll) return;
		const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
		if (nearBottom) bottomRef.current?.scrollIntoView({ block: "end" });
	});

	const empty = messages.length === 0 && !streaming;

	return (
		<div class="chat">
			{empty && (
				<div class="welcome">
					<div class="welcome-title">Relay</div>
					<div class="welcome-hint">
						Ask Relay to fix, build, or explain something. Type <b>@</b> to attach project files.
					</div>
				</div>
			)}
			<div class="chat-scroll" ref={scrollRef}>
				{messages.map((msg, i) => <MessageView key={i} msg={msg} />)}
				{streaming && (
					<div class="message agent streaming">
						{draftToolCalls.map((tc, i) => <ToolCallView key={`draft-${i}`} tool={tc} />)}
						{draftText.trim() && <Markdown text={draftText} />}
						<div class="run-status">
							<span class="spinner" />
							<span>{statusText || "Working..."}</span>
						</div>
					</div>
				)}
				<div ref={bottomRef} />
			</div>
		</div>
	);
}
