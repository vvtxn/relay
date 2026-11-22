import { createMemo, createSignal, For, Show } from "solid-js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query";
import type { LlmModelSelection } from "@vvtxn/client/protocol.ts";
import type { SessionStreamState } from "@vvtxn/client/session-state.ts";
import { filesQuery } from "#/api/queries.ts";
import { cancelRun, sendMessage } from "#/api/mutations.ts";
import { appendError, appendUserMessage, setRunning, setThreadModel, streamState } from "#/state/session.ts";
import { ModelSelector } from "#/components/ModelSelector.tsx";

const MAX_FILE_HITS = 10;

export function Composer(props: { sessionId: string; defaultModel: string }) {
	const queryClient = useQueryClient();
	const [value, setValue] = createSignal("");
	const [mentionStart, setMentionStart] = createSignal(-1);
	const [mentionQuery, setMentionQuery] = createSignal("");
	const [highlight, setHighlight] = createSignal(0);
	let textRef: HTMLTextAreaElement | undefined;

	const running = () => streamState().running;
	const mentionOpen = () => mentionStart() >= 0;

	// The mention picker is the only consumer. Keeping the query disabled until
	// it opens matters for performance: Solid holds a route transition open
	// until every query resource created inside it settles, and a fetch on
	// mount would delay every session switch by one round trip.
	const files = useQuery(() => ({ ...filesQuery(props.sessionId), enabled: mentionOpen() }));

	const send = useMutation(() => ({
		mutationFn: (input: { content: string; model?: LlmModelSelection }) =>
			sendMessage(props.sessionId, input.content, input.model),
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
		// `isLoading` covers the initial fetch (pending + fetching). Returning
		// early avoids reading `.data` while the resource is pending — reading it
		// would suspend the route's Suspense boundary and flash the boot screen.
		if (files.isLoading) return [];
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
		const model = streamState().model;
		send.mutate({
			content,
			...(model
				? {
						model: {
							preset: model.preset,
							model: model.model,
							...(model.contextTokens ? { contextTokens: model.contextTokens } : {}),
						},
					}
				: {}),
		});
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
					<Show
						when={filtered().length > 0}
						fallback={
							<div class="mention-empty">{files.isLoading ? "Loading files…" : "No matching files"}</div>
						}
					>
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
					onFocus={() => void queryClient.prefetchQuery(filesQuery(props.sessionId))}
					onInput={handleInput}
					onKeyDown={handleKeyDown}
				/>
				<div class="composer-actions">
					<div class="composer-actions-left">
						<ModelSelector
							current={streamState().model}
							defaultModel={props.defaultModel}
							onSelect={(selection, label) => {
								setThreadModel({
									preset: selection.preset,
									model: selection.model,
									label,
									...(selection.contextTokens ? { contextTokens: selection.contextTokens } : {}),
								});
							}}
						/>
						<span class="composer-hint">
							{streamState().running ? statusLabel(streamState()) : "Enter to send • @ for files"}
						</span>
					</div>
					<Show
						when={running()}
						fallback={
							<button type="button" class="btn primary" disabled={!value().trim()} onClick={submit}>
								Send
							</button>
						}
					>
						<button type="button" class="btn danger" onClick={() => stop.mutate()}>
							Stop
						</button>
					</Show>
				</div>
			</div>
		</div>
	);
}

function statusLabel(state: SessionStreamState): string {
	switch (state.phase) {
		case "preparing-workspace":
			return "Preparing workspace...";
		case "queued":
			return state.queuePosition !== null ? `Waiting for box (#${state.queuePosition})...` : "Waiting for box...";
		case "starting-box":
			return "Starting box...";
	}
	switch (state.status.kind) {
		case "thinking":
			return "Thinking...";
		case "writing":
			return "Writing...";
		case "running_tool":
			return `Running ${state.status.toolName}...`;
		default:
			return "";
	}
}
