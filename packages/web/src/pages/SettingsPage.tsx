import { createEffect, createSignal, For, Show } from "solid-js";
import { useNavigate, useParams } from "@tanstack/solid-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query";
import type { LlmPreset, SettingsResponse, UpdateSettingsRequest } from "@vvtxn/client/protocol.ts";
import { configQuery, meQuery, modelsQuery, settingsQuery } from "#/api/queries.ts";
import { updateSettings } from "#/api/mutations.ts";
import { readStoredSessionId } from "#/api/storage.ts";
import { RelayError } from "@vvtxn/client/services.ts";
import { queryKeys } from "#/api/query-client.ts";
import { signOut } from "#/auth/auth.ts";
import { BootScreen } from "#/components/BootScreen.tsx";
import { setTheme, theme } from "#/state/theme.ts";
import { VERSION } from "#/version.ts";

type ProviderDraft = "openai" | "anthropic";

const CUSTOM_PRESET = "custom";
const DEFAULT_PRESET = "default";
const OTHER_MODEL = "__other__";

function ContextHint(props: { tokens: number | undefined }) {
	return (
		<Show when={props.tokens}>
			{(tokens) => <span class="settings-context">{(tokens() / 1000).toFixed(0)}k context</span>}
		</Show>
	);
}

function SettingsPanel(props: { onBack: () => void }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const me = useQuery(() => meQuery);
	const config = useQuery(() => configQuery);
	const settings = useQuery(() => settingsQuery);

	const [presetId, setPresetId] = createSignal(DEFAULT_PRESET);
	const [modelId, setModelId] = createSignal("");
	const [otherModelDraft, setOtherModelDraft] = createSignal("");
	const [providerDraft, setProviderDraft] = createSignal<ProviderDraft>("openai");
	const [baseUrlDraft, setBaseUrlDraft] = createSignal("");
	const [modelTextDraft, setModelTextDraft] = createSignal("");
	const [contextDraft, setContextDraft] = createSignal("");
	const [draftKey, setDraftKey] = createSignal("");
	const [message, setMessage] = createSignal("");
	const [error, setError] = createSignal("");

	const selectedPreset = () => settings.data?.presets.find((preset) => preset.id === presetId());
	const isCustom = () => presetId() === CUSTOM_PRESET;
	const isDefault = () => presetId() === DEFAULT_PRESET;
	const hasModels = () => !isCustom() && !isDefault();
	const models = useQuery(() => ({ ...modelsQuery(presetId()), enabled: hasModels() }));
	const modelOptions = () => models.data?.models ?? selectedPreset()?.models ?? [];
	const keyApplies = () => settings.data?.llm.preset === presetId() && settings.data.apiKey.set;
	const interfaceLabel = () =>
		config.data?.provider === "anthropic" || providerDraft() === "anthropic"
			? "Anthropic Messages"
			: "OpenAI-compatible chat completions";

	// Hydrate the form from the server whenever the saved settings change. A
	// background refetch that returns identical data keeps the same object, so
	// no-op refreshes never clobber in-progress edits.
	let hydrated: SettingsResponse | undefined;
	createEffect(() => {
		const data = settings.data;
		if (!data || data === hydrated) return;
		hydrated = data;
		const preset = data.presets.find((entry) => entry.id === data.llm.preset);
		setPresetId(data.llm.preset);
		applyModelDraft(preset, data.llm.model ?? preset?.models[0]?.id ?? "");
		setProviderDraft(data.llm.provider ?? data.defaults.provider);
		setBaseUrlDraft(data.llm.baseURL ?? "");
		setModelTextDraft(data.llm.model ?? "");
		setContextDraft(data.llm.contextTokens ? String(data.llm.contextTokens) : "");
	});

	// Auth seam: a 401 sends the user back through the boot/login flow.
	createEffect(() => {
		if (me.isError && me.error instanceof RelayError && me.error.status === 401) {
			void navigate({ to: "/", replace: true });
		}
	});

	const save = useMutation(() => ({
		mutationFn: (request: UpdateSettingsRequest) => updateSettings(request),
		onSuccess: async () => {
			setDraftKey("");
			setMessage("Saved.");
			setError("");
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
				queryClient.invalidateQueries({ queryKey: queryKeys.config }),
			]);
		},
		onError: (err) => {
			setMessage("");
			setError(err instanceof Error ? err.message : String(err));
		},
	}));

	function canSave(): boolean {
		if (isCustom()) {
			if (baseUrlDraft().trim().length === 0 || modelTextDraft().trim().length === 0) return false;
			const context = contextDraft().trim();
			if (context.length > 0) {
				const tokens = Number(context);
				if (!Number.isInteger(tokens) || tokens < 4096) return false;
			}
			return true;
		}
		if (hasModels() && modelId() === OTHER_MODEL && otherModelDraft().trim().length === 0) return false;
		return true;
	}

	function buildRequest(): UpdateSettingsRequest {
		const request: UpdateSettingsRequest = { preset: presetId() };
		if (isCustom()) {
			request.provider = providerDraft();
			request.baseURL = baseUrlDraft().trim();
			request.model = modelTextDraft().trim();
			const context = contextDraft().trim();
			request.contextTokens = context.length > 0 ? Number(context) : null;
		} else if (!isDefault()) {
			const other = modelId() === OTHER_MODEL;
			request.model = other ? otherModelDraft().trim() : modelId();
			const option = other ? undefined : modelOptions().find((model) => model.id === modelId());
			request.contextTokens = option?.contextTokens ?? null;
		}
		const key = draftKey().trim();
		if (key) request.apiKey = key;
		return request;
	}

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		if (!canSave()) return;
		save.mutate(buildRequest());
	}

	function clearKey(): void {
		const saved = settings.data;
		if (!saved) return;
		save.mutate({ preset: saved.llm.preset, apiKey: null });
	}

	function onPresetChange(id: string): void {
		const data = settings.data;
		const preset = data?.presets.find((entry) => entry.id === id);
		setPresetId(id);
		setMessage("");
		setError("");
		// A pasted key belongs to the preset it was entered for; carrying it
		// into a different provider would bind it to the wrong host on save.
		setDraftKey("");
		const saved = data?.llm;
		const presetModels = preset?.models ?? [];
		const savedModel = saved?.preset === id && saved.model ? saved.model : (presetModels[0]?.id ?? "");
		applyModelDraft(preset, savedModel);
		if (id === CUSTOM_PRESET && data) {
			const reuse = saved?.preset === CUSTOM_PRESET;
			setProviderDraft((reuse ? saved.provider : null) ?? data.defaults.provider);
			setBaseUrlDraft(reuse ? (saved.baseURL ?? "") : "");
			setModelTextDraft(reuse ? (saved.model ?? "") : "");
			setContextDraft(reuse && saved.contextTokens ? String(saved.contextTokens) : "");
		}
	}

	/** Sets the model picker for a preset, honoring the "Other…" escape hatch. */
	function applyModelDraft(preset: LlmPreset | undefined, savedModel: string): void {
		const options = preset?.models ?? [];
		const allowOther = preset?.allowAnyModel !== false;
		if (options.some((model) => model.id === savedModel)) {
			setModelId(savedModel);
			setOtherModelDraft("");
			return;
		}
		if (savedModel && allowOther) {
			setModelId(OTHER_MODEL);
			setOtherModelDraft(savedModel);
			return;
		}
		// An unknown model on an allowlisted preset (e.g. a row saved before the
		// allowlist was enforced) falls back to the curated default instead of
		// leaving the picker blank.
		setModelId(options[0]?.id ?? "");
		setOtherModelDraft("");
	}

	/** Editing the key retires the previous save/error notice. */
	function onKeyInput(event: Event & { currentTarget: HTMLInputElement }): void {
		setDraftKey(event.currentTarget.value);
		setMessage("");
		setError("");
	}

	return (
		<Show when={me.data} fallback={<BootScreen />}>
			{(user) => (
				<div class="settings">
					<header class="settings-header">
						<button type="button" class="status-action" onClick={props.onBack}>
							← chat
						</button>
						<span class="settings-title">Settings</span>
						<span class="settings-version">v{VERSION}</span>
					</header>

					<div class="settings-body">
						<section class="settings-section">
							<h2 class="settings-section-title">Account</h2>
							<div class="settings-account">
								<Show when={user().avatarUrl}>
									<img class="avatar avatar-lg" src={user().avatarUrl} alt="" />
								</Show>
								<div class="settings-account-info">
									<span class="settings-value">{user().name ?? user().id}</span>
									<span class="settings-hint">
										{user().provider === "local"
											? "local mode"
											: user().provider
												? `signed in via ${user().provider}`
												: "signed in"}
									</span>
								</div>
							</div>
							<Show when={user().provider !== "local"}>
								<div class="settings-actions">
									<button type="button" class="btn" onClick={() => void signOut()}>
										Sign out
									</button>
								</div>
							</Show>
						</section>

						<section class="settings-section">
							<h2 class="settings-section-title">Appearance</h2>
							<div class="settings-row">
								<span class="settings-label">Theme</span>
								<div class="theme-toggle">
									<button
										type="button"
										class={theme() === "dark" ? "theme-option active" : "theme-option"}
										aria-pressed={theme() === "dark"}
										onClick={() => setTheme("dark")}
									>
										Dark
									</button>
									<button
										type="button"
										class={theme() === "light" ? "theme-option active" : "theme-option"}
										aria-pressed={theme() === "light"}
										onClick={() => setTheme("light")}
									>
										Light
									</button>
								</div>
							</div>
							<p class="settings-hint">Stored in this browser.</p>
						</section>

						<section class="settings-section">
							<h2 class="settings-section-title">Model & API key</h2>
							<p class="settings-hint">
								Used by the server to call the model on your behalf. Stored per account and never shown
								again.
							</p>
							<Show when={settings.isError}>
								<p class="settings-error">
									Could not load your settings:{" "}
									{settings.error instanceof Error ? settings.error.message : String(settings.error)}
								</p>
							</Show>
							<Show when={!settings.isError && settings.data}>
								<div class="settings-row">
									<label class="settings-label" for="relay-preset">
										Provider
									</label>
									<select
										id="relay-preset"
										class="input settings-select"
										value={presetId()}
										onChange={(event) => onPresetChange(event.currentTarget.value)}
									>
										<For each={settings.data?.presets ?? []}>
											{(preset) => <option value={preset.id}>{preset.label}</option>}
										</For>
									</select>
								</div>
								<Show when={selectedPreset()?.hint}>
									{(hint) => <p class="settings-hint">{hint()}</p>}
								</Show>

								<Show when={isCustom()}>
									<div class="settings-row">
										<label class="settings-label" for="relay-provider">
											API family
										</label>
										<select
											id="relay-provider"
											class="input settings-select"
											value={providerDraft()}
											onChange={(event) =>
												setProviderDraft(event.currentTarget.value as ProviderDraft)
											}
										>
											<option value="openai">OpenAI-compatible</option>
											<option value="anthropic">Anthropic Messages</option>
										</select>
									</div>
									<div class="settings-row settings-stack">
										<label class="settings-label" for="relay-base-url">
											Base URL
										</label>
										<input
											id="relay-base-url"
											class="input"
											type="url"
											placeholder="https://example.com/v1"
											value={baseUrlDraft()}
											onInput={(event) => setBaseUrlDraft(event.currentTarget.value)}
										/>
									</div>
									<div class="settings-row settings-stack">
										<label class="settings-label" for="relay-model-text">
											Model id
										</label>
										<input
											id="relay-model-text"
											class="input"
											placeholder="model-id"
											value={modelTextDraft()}
											onInput={(event) => setModelTextDraft(event.currentTarget.value)}
										/>
									</div>
									<div class="settings-row settings-stack">
										<label class="settings-label" for="relay-context">
											Context tokens (optional)
										</label>
										<input
											id="relay-context"
											class="input"
											type="number"
											min="4096"
											step="1024"
											placeholder="e.g. 128000"
											value={contextDraft()}
											onInput={(event) => setContextDraft(event.currentTarget.value)}
										/>
									</div>
								</Show>

								<Show when={hasModels()}>
									<div class="settings-row">
										<label class="settings-label" for="relay-model">
											Model
										</label>
										<select
											id="relay-model"
											class="input settings-select"
											value={modelId()}
											onChange={(event) => setModelId(event.currentTarget.value)}
										>
											<For each={modelOptions()}>
												{(model) => <option value={model.id}>{model.label}</option>}
											</For>
											<Show when={selectedPreset()?.allowAnyModel !== false}>
												<option value={OTHER_MODEL}>Other…</option>
											</Show>
										</select>
									</div>
									<Show when={modelId() === OTHER_MODEL}>
										<div class="settings-row settings-stack">
											<label class="settings-label" for="relay-model-other">
												Model id
											</label>
											<input
												id="relay-model-other"
												class="input"
												placeholder="model-id"
												value={otherModelDraft()}
												onInput={(event) => setOtherModelDraft(event.currentTarget.value)}
											/>
										</div>
									</Show>
									<p class="settings-hint">
										<ContextHint
											tokens={
												modelOptions().find((model) => model.id === modelId())?.contextTokens
											}
										/>
										{models.isFetching ? " · refreshing catalog…" : ""}
										{models.data?.source === "curated" && !models.isFetching
											? " · curated list"
											: ""}
									</p>
								</Show>

								<Show when={settings.data?.effective}>
									{(effective) => (
										<p class="settings-hint">
											Next run: {effective().label} · {effective().model} (
											{(effective().contextTokens / 1000).toFixed(0)}k context)
										</p>
									)}
								</Show>

								<div class="settings-row">
									<span class="settings-label">API key</span>
									<span class="settings-value">
										<Show
											when={keyApplies()}
											fallback={<span class="settings-empty">not set for this provider</span>}
										>
											set (••••{settings.data?.apiKey.hint})
										</Show>
									</span>
								</div>

								<form class="settings-form" onSubmit={submit}>
									<input
										class="input"
										type="password"
										autocomplete="new-password"
										name="relay-api-key"
										placeholder={
											keyApplies()
												? "Paste a new key to replace the saved one"
												: `Paste your ${selectedPreset()?.label ?? ""} API key`
										}
										value={draftKey()}
										onInput={onKeyInput}
									/>
									<p class="settings-hint">
										Keys are bound to the selected provider. Switching providers requires entering a
										new key; the old one is never sent to a different host.
									</p>
									<div class="settings-actions">
										<Show when={keyApplies()}>
											<button
												type="button"
												class="btn danger"
												disabled={save.isPending}
												onClick={clearKey}
											>
												Clear key
											</button>
										</Show>
										<button
											type="submit"
											class="btn primary"
											disabled={save.isPending || !canSave()}
										>
											{save.isPending ? "Saving…" : "Save"}
										</button>
									</div>
								</form>
								<Show when={error()}>
									<p class="settings-error">{error()}</p>
								</Show>
								<Show when={!error() && message()}>
									<p class="settings-ok">{message()}</p>
								</Show>
								<Show when={isCustom()}>
									<p class="settings-hint">Interface: {interfaceLabel()}.</p>
								</Show>
							</Show>
						</section>
					</div>
				</div>
			)}
		</Show>
	);
}

/**
 * Nested under `/s/:sessionId`: rendered on top of the live chat so the
 * session, its stream, and the composer keep running behind it.
 */
export function SessionSettingsRoute() {
	const params = useParams({ from: "/s/$sessionId/settings" });
	const navigate = useNavigate();
	return (
		<div class="settings-overlay">
			<SettingsPanel
				onBack={() => void navigate({ to: "/s/$sessionId", params: { sessionId: params().sessionId } })}
			/>
		</div>
	);
}

/**
 * Standalone page (CLI deep link to `/settings`). Returns to the last chat
 * opened in this browser, falling back to the boot flow.
 */
export function SettingsPage() {
	const navigate = useNavigate();
	const onBack = () => {
		const sessionId = readStoredSessionId();
		if (sessionId) {
			void navigate({ to: "/s/$sessionId", params: { sessionId } });
			return;
		}
		void navigate({ to: "/" });
	};
	return <SettingsPanel onBack={onBack} />;
}
