import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { viewMessages } from "@vvtxn/client/session-state.ts";
import { streamState } from "@/state/session.ts";
import { MessageView } from "./MessageView.tsx";

const NEAR_BOTTOM_PX = 64;

export function ChatView(props: { model: string; version: string }) {
	let scrollRef: HTMLDivElement | undefined;
	const messages = createMemo(() => viewMessages(streamState()));
	const [stuck, setStuck] = createSignal(true);

	const updateStuck = () => {
		if (!scrollRef) return;
		setStuck(scrollRef.scrollHeight - scrollRef.scrollTop - scrollRef.clientHeight < NEAR_BOTTOM_PX);
	};

	const scrollToBottom = () => {
		if (!scrollRef) return;
		scrollRef.scrollTop = scrollRef.scrollHeight;
		setStuck(true);
	};

	// Auto-scroll only while the user is already at the bottom, so streaming
	// output never yanks the viewport away from earlier messages.
	createEffect(() => {
		messages();
		streamState().draftText;
		if (stuck()) scrollToBottom();
	});

	return (
		<div class="chat-wrap">
			<div class="chat" ref={scrollRef} onScroll={updateStuck}>
				<Show
					when={messages().length > 0}
					fallback={
						<div class="welcome">
							<div class="welcome-mark">RELAY</div>
							<div class="welcome-meta">
								<span>v{props.version}</span>
								<span>{props.model.split("/").pop()}</span>
							</div>
							<div class="welcome-hints">
								Send a message, type <code>@</code> to mention files, and press Stop to cancel a run.
							</div>
						</div>
					}
				>
					<For each={messages()}>{(msg) => <MessageView msg={msg} />}</For>
				</Show>
			</div>
			<Show when={!stuck()}>
				<button type="button" class="scroll-bottom" onClick={scrollToBottom}>Jump to latest</button>
			</Show>
		</div>
	);
}
