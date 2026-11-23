import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, Suspense } from "solid-js";
import { useQuery, useQueryClient } from "@tanstack/solid-query";
import type { LlmModelSelection } from "@vvtxn/client/protocol.ts";
import { modelCatalogQuery, settingsQuery } from "#/api/queries.ts";

type CurrentModel = {
	preset: string;
	model: string;
	label?: string;
	contextTokens?: number;
} | null;

interface Row {
	preset: string;
	label: string;
	model: string;
	modelLabel: string;
	contextTokens?: number;
}

/**
 * Amp-style thread model picker: a button beside the composer that opens a
 * grouped list of every connected subscription's models. Selecting a model
 * overrides the account default for this thread only (sticky until changed).
 *
 * The popover body is a separate component mounted inside a `<Suspense>`: its
 * query hooks and derived memos are created under that boundary, so a first
 * fetch suspends the popover (local "Loading models…" row) rather than the
 * router's match boundary — whose fallback is the full-screen BootScreen.
 * The trigger button itself never reads query data for the same reason.
 */
export function ModelSelector(props: {
	current: CurrentModel;
	defaultModel: string;
	/** `null` clears the thread override so the account default applies. */
	onSelect: (selection: LlmModelSelection | null, label: string) => void;
}) {
	const [open, setOpen] = createSignal(false);
	const queryClient = useQueryClient();
	let rootRef: HTMLDivElement | undefined;
	let buttonRef: HTMLButtonElement | undefined;

	// Warm the queries before the popover opens, so it usually paints without
	// even a local loading row.
	const prefetch = (): void => {
		void queryClient.prefetchQuery(settingsQuery);
		void queryClient.prefetchQuery(modelCatalogQuery);
	};

	const close = (): void => {
		setOpen(false);
		buttonRef?.focus();
	};

	const buttonLabel = () => {
		const current = props.current;
		if (!current) return props.defaultModel;
		return current.label ?? current.model;
	};

	createEffect(() => {
		if (!open()) return;
		const onPointerDown = (event: PointerEvent): void => {
			if (rootRef && event.target instanceof Node && !rootRef.contains(event.target)) setOpen(false);
		};
		globalThis.addEventListener("pointerdown", onPointerDown);
		onCleanup(() => globalThis.removeEventListener("pointerdown", onPointerDown));
	});

	return (
		<div class="model-selector" ref={rootRef}>
			<button
				ref={buttonRef}
				type="button"
				class={open() ? "model-button open" : "model-button"}
				aria-haspopup="listbox"
				aria-expanded={open()}
				title="Model for this thread"
				onMouseEnter={prefetch}
				onFocus={prefetch}
				onClick={() => (open() ? close() : setOpen(true))}
			>
				<span class="model-button-name">{buttonLabel()}</span>
				<span class="model-button-caret">▾</span>
			</button>

			<Show when={open()}>
				<Suspense
					fallback={
						<div class="model-popover">
							<div class="model-empty">Loading models…</div>
						</div>
					}
				>
					<ModelPickerBody
						current={props.current}
						defaultModel={props.defaultModel}
						onSelect={(selection, label) => {
							props.onSelect(selection, label);
							close();
						}}
						onClose={close}
					/>
				</Suspense>
			</Show>
		</div>
	);
}

function ModelPickerBody(props: {
	current: CurrentModel;
	defaultModel: string;
	/** `null` clears the thread override so the account default applies. */
	onSelect: (selection: LlmModelSelection | null, label: string) => void;
	onClose: () => void;
}) {
	const settings = useQuery(() => settingsQuery);
	const catalog = useQuery(() => modelCatalogQuery);
	const [highlight, setHighlight] = createSignal(0);
	let popoverRef: HTMLDivElement | undefined;

	onMount(() => popoverRef?.focus());

	const connectedPresets = createMemo(
		() => new Set((settings.data?.connections ?? []).map((connection) => connection.preset)),
	);

	const groups = createMemo(() => {
		const groups = catalog.data?.groups ?? [];
		if (groups.length > 0) return groups;
		return (settings.data?.presets ?? [])
			.filter((preset) => connectedPresets().has(preset.id))
			.map((preset) => ({
				preset: preset.id,
				label: preset.label,
				models: [...preset.models],
				source: "curated" as const,
			}));
	});

	const rows = createMemo<Row[]>(() =>
		groups().flatMap((group) =>
			group.models.map((model) => ({
				preset: group.preset,
				label: group.label,
				model: model.id,
				modelLabel: model.label,
				...(model.contextTokens ? { contextTokens: model.contextTokens } : {}),
			})),
		),
	);

	const choose = (row: Row): void => {
		props.onSelect(
			{
				preset: row.preset,
				model: row.model,
				...(row.contextTokens ? { contextTokens: row.contextTokens } : {}),
			},
			row.modelLabel,
		);
	};

	/** Display label for the account-default row (falls back to the raw ids). */
	const defaultLabel = () => {
		const effective = settings.data?.effective;
		if (!effective) return props.defaultModel;
		const preset = settings.data?.presets.find((item) => item.id === effective.preset);
		const model = preset?.models.find((entry) => entry.id === effective.model);
		return model ? `${effective.label} · ${model.label}` : `${effective.label} · ${effective.model}`;
	};

	/**
	 * "Account default" drops the thread override instead of pinning the current
	 * default as a sticky selection, so the thread keeps following the account
	 * default when it changes.
	 */
	const chooseDefault = (): void => {
		props.onSelect(null, defaultLabel());
	};

	const onKeyDown = (event: KeyboardEvent): void => {
		const options = rows();
		if (event.key === "Escape") {
			event.preventDefault();
			props.onClose();
			return;
		}
		if (options.length === 0) return;
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
		if (event.key === "Enter") {
			event.preventDefault();
			const row = options[highlight()];
			if (row) choose(row);
		}
	};

	return (
		<div ref={popoverRef} class="model-popover" role="listbox" tabIndex={-1} onKeyDown={onKeyDown}>
			<div class="model-popover-head">
				<span class="model-popover-title">Model</span>
				<span class="settings-hint">applies from the next message</span>
			</div>
			<button
				type="button"
				class={props.current === null ? "model-item model-default selected" : "model-item model-default"}
				aria-selected={props.current === null}
				onClick={chooseDefault}
			>
				<span class="model-item-name">Account default</span>
				<span class="model-item-note">{defaultLabel()}</span>
			</button>
			<Show
				when={groups().length > 0}
				fallback={
					<div class="model-empty">
						{settings.isFetching
							? "Loading connections…"
							: "Connect a subscription in Settings to switch models."}
					</div>
				}
			>
				<For each={groups()}>
					{(group) => {
						const offset = () =>
							rows().findIndex((row) => row.preset === group.preset && row.model === group.models[0]?.id);
						return (
							<div class="model-group">
								<div class="model-group-title">
									<span>{group.label}</span>
									<Show when={connectedPresets().has(group.preset)}>
										<span class="model-pays">subscription</span>
									</Show>
								</div>
								<For each={group.models}>
									{(model, index) => {
										const absolute = () => offset() + index();
										const active = () => highlight() === absolute();
										const selected = () =>
											props.current?.preset === group.preset && props.current?.model === model.id;
										return (
											<button
												type="button"
												class={
													active()
														? "model-item active"
														: selected()
															? "model-item selected"
															: "model-item"
												}
												role="option"
												aria-selected={selected()}
												onMouseEnter={() => setHighlight(absolute())}
												onClick={() =>
													choose({
														preset: group.preset,
														label: group.label,
														model: model.id,
														modelLabel: model.label,
														...(model.contextTokens
															? { contextTokens: model.contextTokens }
															: {}),
													})
												}
											>
												<span class="model-item-name">{model.label}</span>
												<Show when={model.contextTokens}>
													{(tokens) => (
														<span class="model-item-note">
															{(tokens() / 1000).toFixed(0)}k
														</span>
													)}
												</Show>
											</button>
										);
									}}
								</For>
							</div>
						);
					}}
				</For>
			</Show>
		</div>
	);
}
