import { createMemo, createSignal, For, Show } from "solid-js";
import { useMutation, useQuery } from "@tanstack/solid-query";
import { filesQuery } from "@/api/queries.ts";
import { cancelRun, sendMessage } from "@/api/mutations.ts";
import { appendError, appendUserMessage, setRunning, streamState } from "@/state/session.ts";

const MAX_FILE_HITS = 10;

export function Composer(props: { sessionId: string }) {
	const [value, setValue] = createSignal("");
	const [mentionStart, setMentionStart] = createSignal(-1);
	const [mentionQuery, setMentionQuery] = createSignal("");
	const [highlight, setHighlight] = createSignal(0);
	let textRef: HTMLTextAreaElement | undefined;

	const files = useQuery(() => filesQuery(props.sessionId));
	const running = () => streamState().running;
	const mentionOpen = () => mentionStart() >= 0;

	const send = useMutation(() => ({
		mutationFn: (content: string) => sendMessage(props.sessionId, content),
		onError: (error) => {
			setRunning(false);
			appendError(error instanceof Error ? error.message : String(error));
		},
	}));

	const stop = useMutation(() => ({
		mutationFn: () => cancelRun(props.sessionId),
		onError: (error) => appendError(error instanceof Error ? error.message : String(error)),
	}));

	const filtered = createMemo(() => {
		const list = files.data ?? [];
		const query = mentionQuery().toLowerCase();
		const matches = query ? list.filter((file) => file.toLowerCase().includes(query)) : list;
		return matches.slice(0, MAX_FILE_HITS);
	});

	function submit(): void {
		const content = value();
		if (!content.trim() || running()) return;
		setValue("");
		closeMentions();
		appendUserMessage(content);
		send.mutate(content);
	}

	function closeMentions(): void {
		setMentionStart(-1);
		setMentionQuery("");
		setHighlight(0);
	}

	function handleInput(event: InputEvent & { currentTarget: HTMLTextAreaElement }): void {
		const target = event.currentTarget;
		const next = target.value;
		setValue(next);
		const pos = target.selectionStart ?? next.length;

		if (mentionOpen()) {
			if (mentionStart() >= 0 && pos > mentionStart() + 1) {
				setMentionQuery(next.slice(mentionStart() + 1, pos));
			} else if (pos <= mentionStart()) {
				closeMentions();
			}
		} else if (pos > 0 && next[pos - 1] === "@") {
			setMentionStart(pos - 1);
			setMentionQuery("");
			setHighlight(0);
		}
	}

	function pick(file: string): void {
		const start = mentionStart();
		const next = `${value().slice(0, start)}@${file} ${value().slice(start + 1 + mentionQuery().length)}`;
		setValue(next);
		closeMentions();
		const cursor = start + file.length + 2;
		requestAnimationFrame(() => {
			textRef?.focus();
			textRef?.setSelectionRange(cursor, cursor);
		});
	}

	function handleKeyDown(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }): void {
		const options = filtered();
		if (mentionOpen() && options.length > 0) {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setHighlight((highlight() + 1) % options.length);
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				setHighlight((highlight() - 1 + options.length) % options.length);
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				const file = options[highlight()];
				if (file) pick(file);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				closeMentions();
				return;
			}
		}
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submit();
		}
	}

	return (
		<div class="composer">
			<Show when={mentionOpen()}>
				<div class="mention-list">
					<Show when={filtered().length > 0} fallback={<div class="mention-empty">No matching files</div>}>
						<For each={filtered()}>
							{(file, index) => (
								<button
									type="button"
									class={index() === highlight() ? "mention-item active" : "mention-item"}
									onMouseDown={(event) => {
										event.preventDefault();
										pick(file);
									}}
								>
									{file}
								</button>
							)}
						</For>
					</Show>
				</div>
			</Show>
			<div class="composer-box">
				<textarea
					ref={textRef}
					class="composer-input"
					rows={3}
					placeholder="Write a message..."
					value={value()}
					onInput={handleInput}
					onKeyDown={handleKeyDown}
				/>
				<div class="composer-actions">
					<span class="composer-hint">
						{streamState().running ? statusLabel(streamState().status) : "Enter to send • @ for files"}
					</span>
					<Show
						when={running()}
						fallback={
							<button
								type="button"
								class="btn primary"
								disabled={!value().trim()}
								onClick={submit}
							>
								Send
							</button>
						}
					>
						<button type="button" class="btn danger" onClick={() => stop.mutate()}>Stop</button>
					</Show>
				</div>
			</div>
		</div>
	);
}

function statusLabel(status: { kind: string; toolName?: string }): string {
	switch (status.kind) {
		case "thinking":
			return "Thinking...";
		case "writing":
			return "Writing...";
		case "running_tool":
			return `Running ${status.toolName}...`;
		default:
			return "";
	}
}
