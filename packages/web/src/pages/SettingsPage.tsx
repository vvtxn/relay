import { createEffect, createSignal, For, onCleanup, Show, Suspense } from "solid-js";
import { useNavigate, useParams } from "@tanstack/solid-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query";
import type { ConnectionStatus, LlmPreset, SettingsResponse, UpdateSettingsRequest } from "@vvtxn/client/protocol.ts";
import { meQuery, modelCatalogQuery, settingsQuery } from "#/api/queries.ts";
import { completeOAuth, removeConnection, setConnection, startOAuth, updateSettings } from "#/api/mutations.ts";
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

interface OAuthFlow {
	preset: string;
	provider: "anthropic" | "openai";
	url: string;
	flow: "paste" | "redirect";
	instructions?: string;
}

function isConnectionPreset(preset: LlmPreset): boolean {
	return preset.id !== DEFAULT_PRESET && preset.id !== CUSTOM_PRESET;
}

function modelLabel(preset: LlmPreset | undefined, modelId: string): string {
	return preset?.models.find((model) => model.id === modelId)?.label ?? modelId;
}

function SettingsPanel(props: { onBack: () => void }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const me = useQuery(() => meQuery);
	const settings = useQuery(() => settingsQuery);
	const catalog = useQuery(() => modelCatalogQuery);

	// Default-model form
	const [defaultPreset, setDefaultPreset] = createSignal(DEFAULT_PRESET);
	const [defaultModel, setDefaultModel] = createSignal("");
	const [defaultStatus, setDefaultStatus] = createSignal("");
	const [defaultError, setDefaultError] = createSignal("");

	// Connection forms
	const [keyDrafts, setKeyDrafts] = createSignal<Record<string, string>>({});
	const [connectionMessage, setConnectionMessage] = createSignal("");
	const [connectionError, setConnectionError] = createSignal("");
	const [connecting, setConnecting] = createSignal<string | null>(null);
	const [oauthFlow, setOauthFlow] = createSignal<OAuthFlow | null>(null);
	const [oauthCode, setOAuthCode] = createSignal("");

	// Custom endpoint (advanced)
	const [customProvider, setCustomProvider] = createSignal<ProviderDraft>("openai");
	const [customBaseUrl, setCustomBaseUrl] = createSignal("");
	const [customModel, setCustomModel] = createSignal("");
	const [customContext, setCustomContext] = createSignal("");
	const [customKey, setCustomKey] = createSignal("");
	const [customStatus, setCustomStatus] = createSignal("");
	const [customError, setCustomError] = createSignal("");

	let hydrated: SettingsResponse | undefined;
	createEffect(() => {
		const data = settings.data;
		if (!data || data === hydrated) return;
		hydrated = data;
		if (data.llm.preset !== DEFAULT_PRESET && data.llm.preset !== CUSTOM_PRESET) {
			setDefaultPreset(data.llm.preset);
			setDefaultModel(data.llm.model ?? "");
		} else if (data.llm.preset === CUSTOM_PRESET) {
			setDefaultPreset(CUSTOM_PRESET);
			setDefaultModel("");
		} else {
			setDefaultPreset(DEFAULT_PRESET);
			setDefaultModel("");
		}
		if (data.llm.preset === CUSTOM_PRESET) {
			setCustomProvider(data.llm.provider === "anthropic" ? "anthropic" : "openai");
			setCustomBaseUrl(data.llm.baseURL ?? "");
			setCustomModel(data.llm.model ?? "");
			setCustomContext(data.llm.contextTokens ? String(data.llm.contextTokens) : "");
		}
	});

	// Auth seam: a 401 sends the user back through the boot/login flow.
	createEffect(() => {
		if (me.isError && me.error instanceof RelayError && me.error.status === 401) {
			void navigate({ to: "/", replace: true });
		}
	});

	let pollToken = 0;
	onCleanup(() => {
		pollToken++;
	});

	const invalidate = async () => {
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
			queryClient.invalidateQueries({ queryKey: queryKeys.config }),
			queryClient.invalidateQueries({ queryKey: queryKeys.modelCatalog }),
		]);
	};

	const saveDefault = useMutation(() => ({
		mutationFn: (request: UpdateSettingsRequest) => updateSettings(request),
		onSuccess: async () => {
			setDefaultStatus("Saved.");
			setDefaultError("");
			await invalidate();
		},
		onError: (error) => {
			setDefaultStatus("");
			setDefaultError(error instanceof Error ? error.message : String(error));
		},
	}));

	const saveCustom = useMutation(() => ({
		mutationFn: (request: UpdateSettingsRequest) => updateSettings(request),
		onSuccess: async () => {
			setCustomKey("");
			setCustomStatus("Saved. New threads use this endpoint.");
			setCustomError("");
			await invalidate();
		},
		onError: (error) => {
			setCustomStatus("");
			setCustomError(error instanceof Error ? error.message : String(error));
		},
	}));

	const connectKey = useMutation(() => ({
		mutationFn: (input: { preset: string; apiKey: string }) => setConnection(input.preset, input.apiKey),
		onSuccess: async (_result, input) => {
			const label = presets().find((preset) => preset.id === input.preset)?.label ?? input.preset;
			setConnectionMessage(`${label} connected.`);
			setConnectionError("");
			setKeyDrafts((drafts) => ({ ...drafts, [input.preset]: "" }));
			await invalidate();
		},
		onError: (error) => {
			setConnectionMessage("");
			setConnectionError(error instanceof Error ? error.message : String(error));
		},
	}));

	const disconnect = useMutation(() => ({
		mutationFn: (preset: string) => removeConnection(preset),
		onSuccess: async () => {
			setConnectionMessage("Disconnected.");
			setConnectionError("");
			await invalidate();
		},
		onError: (error) => {
			setConnectionMessage("");
			setConnectionError(error instanceof Error ? error.message : String(error));
		},
	}));

	const finishOAuth = useMutation(() => ({
		mutationFn: (input: { provider: string; code: string }) => completeOAuth(input.provider, input.code),
		onSuccess: async () => {
			setOauthFlow(null);
			setOAuthCode("");
			setConnectionMessage("Subscription connected.");
			setConnectionError("");
			await invalidate();
		},
		onError: (error) => {
			setConnectionError(error instanceof Error ? error.message : String(error));
		},
	}));

	const connectionFor = (preset: string): ConnectionStatus | undefined =>
		settings.data?.connections.find((connection) => connection.preset === preset);

	const presets = () => settings.data?.presets ?? [];
	const connectionPresets = () => presets().filter(isConnectionPreset);

	/** Groups of models offered by connected subscriptions. */
	const modelGroups = () => {
		const groups = catalog.data?.groups ?? [];
		if (groups.length > 0) return groups;
		const connected = new Set((settings.data?.connections ?? []).map((connection) => connection.preset));
		return presets()
			.filter((preset) => connected.has(preset.id))
			.map((preset) => ({
				preset: preset.id,
				label: preset.label,
				models: [...preset.models],
				source: "curated",
			}));
	};

	const effectiveLabel = () => {
		const effective = settings.data?.effective;
		if (!effective) return "";
		return `${effective.label} · ${modelLabel(
			presets().find((preset) => preset.id === effective.preset),
			effective.model,
		)}`;
	};

	function saveDefaultModel(): void {
		const preset = defaultPreset();
		if (preset === DEFAULT_PRESET) {
			saveDefault.mutate({ preset: DEFAULT_PRESET });
			return;
		}
		if (preset === CUSTOM_PRESET) {
			// The endpoint fields live in the advanced section; keep the stored
			// custom configuration as the default.
			saveDefault.mutate({ preset: CUSTOM_PRESET });
			return;
		}
		const option = modelGroups()
			.find((group) => group.preset === preset)
			?.models.find((model) => model.id === defaultModel());
		saveDefault.mutate({
			preset,
			model: defaultModel(),
			contextTokens: option?.contextTokens ?? null,
		});
	}

	async function beginSignIn(preset: LlmPreset): Promise<void> {
		const provider = preset.oauth?.provider;
		if (!provider) return;
		setConnecting(preset.id);
		setConnectionError("");
		setConnectionMessage("");
		setOAuthCode("");
		try {
			const start = await startOAuth(provider);
			setOauthFlow({ preset: preset.id, provider, ...start });
			globalThis.open(start.url, "_blank", "noopener,noreferrer");
			if (start.flow === "redirect") {
				const token = ++pollToken;
				void pollForConnection(preset.id, token);
			}
		} catch (error) {
			setConnectionError(error instanceof Error ? error.message : String(error));
		} finally {
			setConnecting(null);
		}
	}

	async function pollForConnection(preset: string, token: number): Promise<void> {
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline && token === pollToken) {
			await new Promise((resolve) => setTimeout(resolve, 2_000));
			if (token !== pollToken) return;
			const result = await settings.refetch();
			if (result.data?.connections.some((connection) => connection.preset === preset)) {
				setOauthFlow(null);
				setConnectionMessage("Subscription connected.");
				await invalidate();
				return;
			}
		}
		if (token !== pollToken) return;
		setOauthFlow(null);
		setConnectionError("Timed out waiting for the provider. Try connecting again.");
	}

	function saveCustomEndpoint(): void {
		const context = customContext().trim();
		saveCustom.mutate({
			preset: CUSTOM_PRESET,
			provider: customProvider(),
			baseURL: customBaseUrl().trim(),
			model: customModel().trim(),
			contextTokens: context.length > 0 ? Number(context) : null,
			...(customKey().trim() ? { apiKey: customKey().trim() } : {}),
		});
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
							<h2 class="settings-section-title">Connections</h2>
							<p class="settings-hint">
								Subscriptions power the model picker in every thread. Credentials are stored encrypted
								per account and never shown again.
							</p>
							<Show when={settings.isError}>
								<p class="settings-error">
									Could not load your connections:{" "}
									{settings.error instanceof Error ? settings.error.message : String(settings.error)}
								</p>
							</Show>
							<Show when={!settings.isError && settings.data}>
								<For each={connectionPresets()}>
									{(preset) => {
										const connection = () => connectionFor(preset.id);
										const draft = () => keyDrafts()[preset.id] ?? "";
										const activeFlow = () => {
											const current = oauthFlow();
											return current?.preset === preset.id ? current : undefined;
										};
										return (
											<div class="connection-card">
												<div class="connection-head">
													<div class="connection-title">
														<span class="settings-value">{preset.label}</span>
														<Show
															when={connection()}
															fallback={
																<span class="connection-badge off">not connected</span>
															}
														>
															{(current) => (
																<span class="connection-badge on">
																	connected
																	{current().hint ? ` · ${current().hint}` : ""}
																</span>
															)}
														</Show>
													</div>
													<Show when={connection()}>
														<button
															type="button"
															class="btn ghost"
															disabled={disconnect.isPending}
															onClick={() => disconnect.mutate(preset.id)}
														>
															Disconnect
														</button>
													</Show>
												</div>
												<Show when={preset.hint}>
													{(hint) => <p class="settings-hint">{hint()}</p>}
												</Show>

												<Show when={preset.auth === "api-key" && !connection()}>
													<form
														class="connection-form"
														onSubmit={(event) => {
															event.preventDefault();
															if (!draft().trim()) return;
															connectKey.mutate({
																preset: preset.id,
																apiKey: draft().trim(),
															});
														}}
													>
														<input
															class="input"
															type="password"
															autocomplete="new-password"
															placeholder={`Paste your ${preset.label} API key`}
															value={draft()}
															onInput={(event) =>
																setKeyDrafts((drafts) => ({
																	...drafts,
																	[preset.id]: event.currentTarget.value,
																}))
															}
														/>
														<button
															type="submit"
															class="btn primary"
															disabled={connectKey.isPending || !draft().trim()}
														>
															Connect
														</button>
													</form>
												</Show>

												<Show when={preset.auth === "api-key" && connection()}>
													<details class="connection-replace">
														<summary>Replace key</summary>
														<form
															class="connection-form"
															onSubmit={(event) => {
																event.preventDefault();
																if (!draft().trim()) return;
																connectKey.mutate({
																	preset: preset.id,
																	apiKey: draft().trim(),
																});
															}}
														>
															<input
																class="input"
																type="password"
																autocomplete="new-password"
																placeholder="Paste a new key"
																value={draft()}
																onInput={(event) =>
																	setKeyDrafts((drafts) => ({
																		...drafts,
																		[preset.id]: event.currentTarget.value,
																	}))
																}
															/>
															<button
																type="submit"
																class="btn"
																disabled={connectKey.isPending || !draft().trim()}
															>
																Save
															</button>
														</form>
													</details>
												</Show>

												<Show when={preset.auth === "oauth" && !connection()}>
													<div class="settings-actions">
														<button
															type="button"
															class="btn primary"
															disabled={connecting() === preset.id}
															onClick={() => void beginSignIn(preset)}
														>
															{connecting() === preset.id
																? "Opening…"
																: `Connect ${preset.label}`}
														</button>
													</div>
												</Show>

												<Show when={activeFlow()}>
													{(active) => (
														<div class="connection-flow">
															<p class="settings-hint">{active().instructions}</p>
															<a
																class="settings-link"
																href={active().url}
																target="_blank"
																rel="noreferrer noopener"
															>
																Open the sign-in page →
															</a>
															<Show when={active().flow === "paste"}>
																<form
																	class="connection-form"
																	onSubmit={(event) => {
																		event.preventDefault();
																		if (!oauthCode().trim()) return;
																		finishOAuth.mutate({
																			provider: active().provider,
																			code: oauthCode().trim(),
																		});
																	}}
																>
																	<input
																		class="input"
																		placeholder="Paste the code (code#state)"
																		value={oauthCode()}
																		onInput={(event) =>
																			setOAuthCode(event.currentTarget.value)
																		}
																	/>
																	<button
																		type="submit"
																		class="btn primary"
																		disabled={
																			finishOAuth.isPending || !oauthCode().trim()
																		}
																	>
																		{finishOAuth.isPending
																			? "Finishing…"
																			: "Finish"}
																	</button>
																</form>
															</Show>
															<Show when={active().flow === "redirect"}>
																<p class="settings-hint">
																	Waiting for the browser sign-in to complete…
																</p>
																<div class="settings-actions">
																	<button
																		type="button"
																		class="btn ghost"
																		onClick={() => {
																			pollToken++;
																			setOauthFlow(null);
																		}}
																	>
																		Cancel
																	</button>
																</div>
															</Show>
														</div>
													)}
												</Show>
											</div>
										);
									}}
								</For>
								<Show when={connectionError()}>
									<p class="settings-error">{connectionError()}</p>
								</Show>
								<Show when={!connectionError() && connectionMessage()}>
									<p class="settings-ok">{connectionMessage()}</p>
								</Show>
							</Show>
						</section>

						<section class="settings-section">
							<h2 class="settings-section-title">New threads start on</h2>
							<p class="settings-hint">
								The default model for a new thread. Switch any thread's model from the composer below
								its prompt.
							</p>
							<Show when={settings.data}>
								<div class="settings-row settings-stack">
									<label class="settings-label" for="relay-default-model">
										Model
									</label>
									<select
										id="relay-default-model"
										class="input settings-select"
										value={`${defaultPreset()}::${defaultModel()}`}
										onChange={(event) => {
											const [preset = DEFAULT_PRESET, model = ""] =
												event.currentTarget.value.split("::");
											setDefaultPreset(preset);
											setDefaultModel(model);
											setDefaultStatus("");
											setDefaultError("");
										}}
									>
										<option value={`${DEFAULT_PRESET}::`}>Server default</option>
										<Show when={settings.data?.llm.preset === CUSTOM_PRESET}>
											<option value={`${CUSTOM_PRESET}::`}>Custom endpoint (below)</option>
										</Show>
										<For each={modelGroups()}>
											{(group) => (
												<optgroup label={group.label}>
													<For each={group.models}>
														{(model) => (
															<option value={`${group.preset}::${model.id}`}>
																{model.label}
															</option>
														)}
													</For>
												</optgroup>
											)}
										</For>
									</select>
								</div>
								<p class="settings-hint">Currently: {effectiveLabel()}</p>
								<div class="settings-actions">
									<button
										type="button"
										class="btn primary"
										disabled={saveDefault.isPending}
										onClick={saveDefaultModel}
									>
										{saveDefault.isPending ? "Saving…" : "Save default"}
									</button>
								</div>
								<Show when={defaultError()}>
									<p class="settings-error">{defaultError()}</p>
								</Show>
								<Show when={!defaultError() && defaultStatus()}>
									<p class="settings-ok">{defaultStatus()}</p>
								</Show>
							</Show>
						</section>

						<Show when={settings.data?.canCustom}>
							<details class="settings-section settings-advanced">
								<summary class="settings-section-title">Advanced · custom endpoint</summary>
								<p class="settings-hint">
									Point Relay at any OpenAI-compatible or Anthropic Messages endpoint. Saving here
									also makes it the default for new threads.
								</p>
								<div class="settings-row">
									<label class="settings-label" for="relay-provider">
										API family
									</label>
									<select
										id="relay-provider"
										class="input settings-select"
										value={customProvider()}
										onChange={(event) =>
											setCustomProvider(event.currentTarget.value as ProviderDraft)
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
										value={customBaseUrl()}
										onInput={(event) => setCustomBaseUrl(event.currentTarget.value)}
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
										value={customModel()}
										onInput={(event) => setCustomModel(event.currentTarget.value)}
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
										value={customContext()}
										onInput={(event) => setCustomContext(event.currentTarget.value)}
									/>
								</div>
								<div class="settings-row settings-stack">
									<label class="settings-label" for="relay-custom-key">
										API key
									</label>
									<input
										id="relay-custom-key"
										class="input"
										type="password"
										autocomplete="new-password"
										placeholder="Paste a key to replace the saved one"
										value={customKey()}
										onInput={(event) => setCustomKey(event.currentTarget.value)}
									/>
								</div>
								<div class="settings-actions">
									<button
										type="button"
										class="btn primary"
										disabled={
											saveCustom.isPending || !customBaseUrl().trim() || !customModel().trim()
										}
										onClick={saveCustomEndpoint}
									>
										{saveCustom.isPending ? "Saving…" : "Save endpoint"}
									</button>
								</div>
								<Show when={customError()}>
									<p class="settings-error">{customError()}</p>
								</Show>
								<Show when={!customError() && customStatus()}>
									<p class="settings-ok">{customStatus()}</p>
								</Show>
							</details>
						</Show>
					</div>
				</div>
			)}
		</Show>
	);
}

function SettingsLoading(props: { onBack: () => void }) {
	return (
		<div class="settings">
			<header class="settings-header">
				<button type="button" class="status-action" onClick={props.onBack}>
					← chat
				</button>
				<span class="settings-title">Settings</span>
			</header>
			<div class="settings-body">
				<p class="settings-hint">Loading settings…</p>
			</div>
		</div>
	);
}

/**
 * Nested under `/s/:sessionId`: rendered on top of the live chat so the
 * session, its stream, and the composer keep running behind it.
 *
 * The panel is wrapped in its own Suspense boundary (the component invocation,
 * not just its JSX) so a cold `settings`/catalog fetch suspends inside the
 * overlay instead of the session route's boundary and never flashes BootScreen.
 */
export function SessionSettingsRoute() {
	const params = useParams({ from: "/s/$sessionId/settings" });
	const navigate = useNavigate();
	const onBack = () => void navigate({ to: "/s/$sessionId", params: { sessionId: params().sessionId } });
	return (
		<div class="settings-overlay">
			<Suspense fallback={<SettingsLoading onBack={onBack} />}>
				<SettingsPanel onBack={onBack} />
			</Suspense>
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
	return (
		<Suspense fallback={<SettingsLoading onBack={onBack} />}>
			<SettingsPanel onBack={onBack} />
		</Suspense>
	);
}
