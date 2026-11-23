import { createEffect, createSignal, For, onCleanup, Show, Suspense, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { useNavigate, useParams } from "@tanstack/solid-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query";
import type {
	ConnectionStatus,
	LlmPreset,
	MeResponse,
	SettingsResponse,
	UpdateSettingsRequest,
} from "@vvtxn/client/protocol.ts";
import { themes, type ThemeName } from "@vvtxn/relay/core/theme.ts";
import { meQuery, modelCatalogQuery, settingsQuery } from "#/api/queries.ts";
import {
	cancelOAuth,
	completeOAuth,
	removeConnection,
	setConnection,
	startOAuth,
	updateSettings,
} from "#/api/mutations.ts";
import { readStoredSessionId } from "#/api/storage.ts";
import { RelayError } from "@vvtxn/client/services.ts";
import { queryKeys } from "#/api/query-client.ts";
import { signOut } from "#/auth/auth.ts";
import { BootScreen } from "#/components/BootScreen.tsx";
import { setTheme, theme } from "#/state/theme.ts";
import { VERSION } from "#/version.ts";

type ProviderDraft = "openai" | "anthropic";
type SettingsTab = "general" | "models";

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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Invalidates every query affected by an LLM settings write. */
function useInvalidateSettings(): () => Promise<void> {
	const queryClient = useQueryClient();
	return async () => {
		await Promise.all([
			queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
			queryClient.invalidateQueries({ queryKey: queryKeys.config }),
			queryClient.invalidateQueries({ queryKey: queryKeys.modelCatalog }),
		]);
	};
}

/* ------------------------------------------------------------------ */
/* Icons                                                               */
/* ------------------------------------------------------------------ */

const iconProps = {
	viewBox: "0 0 16 16",
	fill: "none",
	stroke: "currentColor",
	"stroke-width": "1.3",
	"stroke-linecap": "round",
	"stroke-linejoin": "round",
	"aria-hidden": "true",
} as const;

const BackIcon: Component = () => (
	<svg {...iconProps} class="settings-icon">
		<path d="M9.5 3.5 5 8l4.5 4.5" />
	</svg>
);

const AccountIcon: Component = () => (
	<svg {...iconProps} class="settings-icon">
		<circle cx="8" cy="5.2" r="2.4" />
		<path d="M3.2 13.2c.6-2.2 2.5-3.6 4.8-3.6s4.2 1.4 4.8 3.6" />
	</svg>
);

const AppearanceIcon: Component = () => (
	<svg {...iconProps} class="settings-icon">
		<circle cx="8" cy="8" r="5.4" />
		<path d="M8 2.6a5.4 5.4 0 0 1 0 10.8Z" fill="currentColor" stroke="none" />
	</svg>
);

const ConnectionsIcon: Component = () => (
	<svg {...iconProps} class="settings-icon">
		<path d="M6.5 9.5 9.5 6.5" />
		<path d="M7 5.2 8.4 3.8a2.6 2.6 0 0 1 3.7 3.7L10.7 8.9" />
		<path d="M9 10.8 7.6 12.2a2.6 2.6 0 0 1-3.7-3.7L5.3 7.1" />
	</svg>
);

const ModelIcon: Component = () => (
	<svg {...iconProps} class="settings-icon">
		<path d="M7.4 2.4 8.5 5.5l3.1 1.1-3.1 1.1-1.1 3.1-1.1-3.1-3.1-1.1 3.1-1.1Z" />
		<path d="M12.2 9.8l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6Z" />
	</svg>
);

const AdvancedIcon: Component = () => (
	<svg {...iconProps} class="settings-icon">
		<path d="M6 4 2.8 8 6 12" />
		<path d="M10 4l3.2 4-3.2 4" />
	</svg>
);

const CheckIcon: Component = () => (
	<svg {...iconProps} class="settings-icon">
		<path d="m3.5 8.5 2.8 2.8 6.2-6.6" />
	</svg>
);

/* ------------------------------------------------------------------ */
/* Shared building blocks                                              */
/* ------------------------------------------------------------------ */

function SectionHeader(props: {
	icon: Component;
	title: string;
	description: string;
	meta?: string | undefined;
	metaOn?: boolean | undefined;
}) {
	return (
		<header class="settings-section-head">
			<span class="settings-section-icon" aria-hidden="true">
				<Dynamic component={props.icon} />
			</span>
			<span class="settings-section-copy">
				<span class="settings-section-title-row">
					<h2 class="settings-section-title">{props.title}</h2>
					<Show when={props.meta}>
						<span class="settings-section-meta" classList={{ on: props.metaOn }}>
							{props.meta}
						</span>
					</Show>
				</span>
				<p class="settings-section-desc">{props.description}</p>
			</span>
		</header>
	);
}

/* ------------------------------------------------------------------ */
/* Account                                                             */
/* ------------------------------------------------------------------ */

function AccountSection(props: { user: MeResponse }) {
	const initials = () => {
		const name = props.user.name?.trim() || props.user.id;
		return name.slice(0, 1).toUpperCase();
	};
	const providerLine = () => {
		if (props.user.provider === "local") return "Local mode — no external identity";
		if (props.user.provider) return `Signed in via ${props.user.provider}`;
		return "Signed in";
	};

	return (
		<section class="settings-section">
			<SectionHeader
				icon={AccountIcon}
				title="Account"
				description="Your identity on this Relay server and how this browser is signed in."
			/>
			<div class="settings-card settings-profile">
				<Show
					when={props.user.avatarUrl}
					fallback={
						<span class="avatar avatar-lg avatar-fallback" aria-hidden="true">
							{initials()}
						</span>
					}
				>
					{(url) => <img class="avatar avatar-lg" src={url()} alt="" />}
				</Show>
				<div class="settings-profile-copy">
					<span class="settings-profile-name">{props.user.name ?? props.user.id}</span>
					<span class="settings-profile-meta">{providerLine()}</span>
				</div>
				<Show when={props.user.provider !== "local"}>
					<button type="button" class="btn ghost" onClick={() => void signOut()}>
						Sign out
					</button>
				</Show>
			</div>
			<dl class="settings-facts">
				<div class="settings-fact">
					<dt>User id</dt>
					<dd>{props.user.id}</dd>
				</div>
				<div class="settings-fact">
					<dt>Sign-in</dt>
					<dd>{props.user.provider ?? "External provider"}</dd>
				</div>
			</dl>
		</section>
	);
}

/* ------------------------------------------------------------------ */
/* Appearance                                                          */
/* ------------------------------------------------------------------ */

function ThemeCard(props: { mode: ThemeName; label: string; description: string }) {
	const palette = () => themes[props.mode];
	return (
		<button
			type="button"
			class="theme-card"
			classList={{ active: theme() === props.mode }}
			aria-pressed={theme() === props.mode}
			onClick={() => setTheme(props.mode)}
		>
			<span
				class="theme-preview"
				style={{ "background-color": palette().background, "border-color": palette().border }}
			>
				<span
					class="theme-preview-rail"
					style={{ "background-color": palette().surface, "border-color": palette().border }}
				/>
				<span class="theme-preview-main">
					<span class="theme-preview-line" style={{ "background-color": palette().textMuted }} />
					<span class="theme-preview-line short" style={{ "background-color": palette().textDim }} />
					<span class="theme-preview-line accent" style={{ "background-color": palette().brand }} />
				</span>
			</span>
			<span class="theme-card-copy">
				<span class="theme-card-label">
					{props.label}
					<Show when={theme() === props.mode}>
						<span class="theme-card-check" aria-hidden="true">
							<CheckIcon />
						</span>
					</Show>
				</span>
				<span class="theme-card-desc">{props.description}</span>
			</span>
		</button>
	);
}

function AppearanceSection() {
	return (
		<section class="settings-section">
			<SectionHeader
				icon={AppearanceIcon}
				title="Appearance"
				description="Pick the palette for this browser. The change applies instantly and is remembered locally."
				meta={theme() === "dark" ? "Dark" : "Light"}
			/>
			<div class="theme-cards">
				<ThemeCard mode="dark" label="Dark" description="Graphite on near-black" />
				<ThemeCard mode="light" label="Light" description="Graphite on paper" />
			</div>
		</section>
	);
}

/* ------------------------------------------------------------------ */
/* Connections                                                         */
/* ------------------------------------------------------------------ */

interface ConnectionCardProps {
	preset: LlmPreset;
	connection: ConnectionStatus | undefined;
	draft: string;
	connecting: boolean;
	connectPending: boolean;
	disconnectPending: boolean;
	onDraft: (value: string) => void;
	onConnect: () => void;
	onDisconnect: () => void;
	onBeginSignIn: () => void;
	flow: OAuthFlow | undefined;
	oauthCode: string;
	onOAuthCode: (value: string) => void;
	onFinishOAuth: () => void;
	finishPending: boolean;
	onCancelOAuth: () => void;
}

function ConnectionCard(props: ConnectionCardProps) {
	const apiKeyForm = (placeholder: string, submitLabel: string) => (
		<form
			class="connection-form"
			onSubmit={(event) => {
				event.preventDefault();
				if (!props.draft.trim()) return;
				props.onConnect();
			}}
		>
			<input
				class="input"
				type="password"
				autocomplete="new-password"
				placeholder={placeholder}
				value={props.draft}
				onInput={(event) => props.onDraft(event.currentTarget.value)}
			/>
			<button type="submit" class="btn primary" disabled={props.connectPending || !props.draft.trim()}>
				{submitLabel}
			</button>
		</form>
	);

	return (
		<div class="connection-card">
			<div class="connection-head">
				<span class="connection-mark" aria-hidden="true">
					{props.preset.label.slice(0, 1)}
				</span>
				<div class="connection-copy">
					<span class="connection-name">{props.preset.label}</span>
					<Show when={props.connection} fallback={<span class="connection-badge off">Not connected</span>}>
						{(current) => (
							<span class="connection-badge on">
								<span class="connection-dot" />
								Connected{current().hint ? ` · ${current().hint}` : ""}
							</span>
						)}
					</Show>
				</div>
				<Show when={props.connection}>
					<button
						type="button"
						class="btn ghost connection-action"
						disabled={props.disconnectPending}
						onClick={props.onDisconnect}
					>
						Disconnect
					</button>
				</Show>
			</div>
			<Show when={props.preset.hint}>{(hint) => <p class="settings-hint">{hint()}</p>}</Show>

			<div class="connection-footer">
				<Show when={props.preset.auth === "api-key" && !props.connection}>
					{apiKeyForm(`Paste your ${props.preset.label} API key`, "Connect")}
				</Show>

				<Show when={props.preset.auth === "api-key" && props.connection}>
					<details class="connection-replace">
						<summary>Replace key</summary>
						{apiKeyForm("Paste a new key", "Save")}
					</details>
				</Show>

				<Show when={props.preset.auth === "oauth" && !props.connection}>
					<div class="settings-actions">
						<button
							type="button"
							class="btn primary"
							disabled={props.connecting}
							onClick={props.onBeginSignIn}
						>
							{props.connecting ? "Opening…" : `Connect ${props.preset.label}`}
						</button>
					</div>
				</Show>

				<Show when={props.flow}>
					{(active) => (
						<div class="connection-flow">
							<p class="settings-hint">{active().instructions}</p>
							<a class="settings-link" href={active().url} target="_blank" rel="noreferrer noopener">
								Open the sign-in page →
							</a>
							<Show when={active().flow === "paste"}>
								<form
									class="connection-form"
									onSubmit={(event) => {
										event.preventDefault();
										if (!props.oauthCode.trim()) return;
										props.onFinishOAuth();
									}}
								>
									<input
										class="input"
										placeholder="Paste the code (code#state)"
										value={props.oauthCode}
										onInput={(event) => props.onOAuthCode(event.currentTarget.value)}
									/>
									<button
										type="submit"
										class="btn primary"
										disabled={props.finishPending || !props.oauthCode.trim()}
									>
										{props.finishPending ? "Finishing…" : "Finish"}
									</button>
								</form>
							</Show>
							<Show when={active().flow === "redirect"}>
								<p class="settings-hint">Waiting for the browser sign-in to complete…</p>
								<div class="settings-actions">
									<button type="button" class="btn ghost" onClick={props.onCancelOAuth}>
										Cancel
									</button>
								</div>
							</Show>
						</div>
					)}
				</Show>
			</div>
		</div>
	);
}

function ConnectionsSection() {
	const settings = useQuery(() => settingsQuery);
	const invalidate = useInvalidateSettings();

	const [keyDrafts, setKeyDrafts] = createSignal<Record<string, string>>({});
	const [message, setMessage] = createSignal("");
	const [error, setError] = createSignal("");
	const [connecting, setConnecting] = createSignal<string | null>(null);
	const [oauthFlow, setOauthFlow] = createSignal<OAuthFlow | null>(null);
	const [oauthCode, setOAuthCode] = createSignal("");

	let pollToken = 0;
	onCleanup(() => {
		pollToken++;
	});

	const connectionFor = (preset: string): ConnectionStatus | undefined =>
		settings.data?.connections.find((connection) => connection.preset === preset);
	const presets = () => (settings.data?.presets ?? []).filter(isConnectionPreset);

	const connectKey = useMutation(() => ({
		mutationFn: (input: { preset: string; apiKey: string }) => setConnection(input.preset, input.apiKey),
		onSuccess: async (_result, input) => {
			const label = presets().find((preset) => preset.id === input.preset)?.label ?? input.preset;
			setMessage(`${label} connected.`);
			setError("");
			setKeyDrafts((drafts) => ({ ...drafts, [input.preset]: "" }));
			await invalidate();
		},
		onError: (cause) => {
			setMessage("");
			setError(errorMessage(cause));
		},
	}));

	const disconnect = useMutation(() => ({
		mutationFn: (preset: string) => removeConnection(preset),
		onSuccess: async () => {
			setMessage("Disconnected.");
			setError("");
			await invalidate();
		},
		onError: (cause) => {
			setMessage("");
			setError(errorMessage(cause));
		},
	}));

	const finishOAuth = useMutation(() => ({
		mutationFn: (input: { provider: string; code: string }) => completeOAuth(input.provider, input.code),
		onSuccess: async () => {
			setOauthFlow(null);
			setOAuthCode("");
			setMessage("Subscription connected.");
			setError("");
			await invalidate();
		},
		onError: (cause) => {
			setError(errorMessage(cause));
		},
	}));

	/** Best effort: drops the server's pending attempt and closes its listener. */
	const cancelSignIn = useMutation(() => ({
		mutationFn: (provider: string) => cancelOAuth(provider),
	}));

	async function beginSignIn(preset: LlmPreset): Promise<void> {
		const provider = preset.oauth?.provider;
		if (!provider) return;
		setConnecting(preset.id);
		setError("");
		setMessage("");
		setOAuthCode("");
		try {
			const start = await startOAuth(provider);
			setOauthFlow({ preset: preset.id, provider, ...start });
			globalThis.open(start.url, "_blank", "noopener,noreferrer");
			if (start.flow === "redirect") {
				const token = ++pollToken;
				void pollForConnection(preset.id, token);
			}
		} catch (cause) {
			setError(errorMessage(cause));
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
				setMessage("Subscription connected.");
				await invalidate();
				return;
			}
		}
		if (token !== pollToken) return;
		setOauthFlow(null);
		setError("Timed out waiting for the provider. Try connecting again.");
	}

	return (
		<section class="settings-section settings-wide">
			<SectionHeader
				icon={ConnectionsIcon}
				title="Connections"
				description="Subscriptions power the model picker in every thread. Credentials are encrypted per account and never shown again."
				meta={
					(settings.data?.connections.length ?? 0) > 0
						? `${settings.data?.connections.length} connected`
						: "Not connected"
				}
				metaOn={(settings.data?.connections.length ?? 0) > 0}
			/>
			<Show when={settings.isError}>
				<p class="settings-error">Could not load your connections: {errorMessage(settings.error)}</p>
			</Show>
			<Show when={settings.data}>
				<div class="connection-grid">
					<For each={presets()}>
						{(preset) => {
							const connection = () => connectionFor(preset.id);
							const draft = () => keyDrafts()[preset.id] ?? "";
							const activeFlow = () => {
								const current = oauthFlow();
								return current?.preset === preset.id ? current : undefined;
							};
							return (
								<ConnectionCard
									preset={preset}
									connection={connection()}
									draft={draft()}
									connecting={connecting() === preset.id}
									connectPending={connectKey.isPending}
									disconnectPending={disconnect.isPending}
									onDraft={(value) => setKeyDrafts((drafts) => ({ ...drafts, [preset.id]: value }))}
									onConnect={() => {
										if (!draft().trim()) return;
										connectKey.mutate({ preset: preset.id, apiKey: draft().trim() });
									}}
									onDisconnect={() => disconnect.mutate(preset.id)}
									onBeginSignIn={() => void beginSignIn(preset)}
									flow={activeFlow()}
									oauthCode={oauthCode()}
									onOAuthCode={setOAuthCode}
									onFinishOAuth={() => {
										const active = activeFlow();
										if (!active || !oauthCode().trim()) return;
										finishOAuth.mutate({
											provider: active.provider,
											code: oauthCode().trim(),
										});
									}}
									finishPending={finishOAuth.isPending}
									onCancelOAuth={() => {
										const active = activeFlow();
										pollToken++;
										setOauthFlow(null);
										setOAuthCode("");
										if (active) cancelSignIn.mutate(active.provider);
									}}
								/>
							);
						}}
					</For>
				</div>
				<Show when={error()}>
					<p class="settings-error">{error()}</p>
				</Show>
				<Show when={!error() && message()}>
					<p class="settings-ok">{message()}</p>
				</Show>
			</Show>
		</section>
	);
}

/* ------------------------------------------------------------------ */
/* Default model                                                       */
/* ------------------------------------------------------------------ */

function ModelSection() {
	const settings = useQuery(() => settingsQuery);
	const catalog = useQuery(() => modelCatalogQuery);
	const invalidate = useInvalidateSettings();

	const [preset, setPreset] = createSignal(DEFAULT_PRESET);
	const [model, setModel] = createSignal("");
	const [status, setStatus] = createSignal("");
	const [error, setError] = createSignal("");

	let hydrated: SettingsResponse | undefined;
	createEffect(() => {
		const data = settings.data;
		if (!data || data === hydrated) return;
		hydrated = data;
		if (data.llm.preset !== DEFAULT_PRESET && data.llm.preset !== CUSTOM_PRESET) {
			setPreset(data.llm.preset);
			setModel(data.llm.model ?? "");
		} else if (data.llm.preset === CUSTOM_PRESET) {
			setPreset(CUSTOM_PRESET);
			setModel("");
		} else {
			setPreset(DEFAULT_PRESET);
			setModel("");
		}
	});

	const save = useMutation(() => ({
		mutationFn: (request: UpdateSettingsRequest) => updateSettings(request),
		onSuccess: async () => {
			setStatus("Saved.");
			setError("");
			await invalidate();
		},
		onError: (cause) => {
			setStatus("");
			setError(errorMessage(cause));
		},
	}));

	/** Groups of models offered by connected subscriptions. */
	const modelGroups = () => {
		const groups = catalog.data?.groups ?? [];
		if (groups.length > 0) return groups;
		const connected = new Set((settings.data?.connections ?? []).map((connection) => connection.preset));
		return (settings.data?.presets ?? [])
			.filter((item) => connected.has(item.id))
			.map((item) => ({
				preset: item.id,
				label: item.label,
				models: [...item.models],
				source: "curated",
			}));
	};

	const effectiveLabel = () => {
		const effective = settings.data?.effective;
		if (!effective) return "";
		const found = settings.data?.presets.find((item) => item.id === effective.preset);
		return `${effective.label} · ${modelLabel(found, effective.model)}`;
	};

	function saveDefaultModel(): void {
		const selected = preset();
		if (selected === DEFAULT_PRESET) {
			save.mutate({ preset: DEFAULT_PRESET });
			return;
		}
		if (selected === CUSTOM_PRESET) {
			// The endpoint fields live in the advanced section; keep the stored
			// custom configuration as the default.
			save.mutate({ preset: CUSTOM_PRESET });
			return;
		}
		const option = modelGroups()
			.find((group) => group.preset === selected)
			?.models.find((entry) => entry.id === model());
		save.mutate({
			preset: selected,
			model: model(),
			contextTokens: option?.contextTokens ?? null,
		});
	}

	return (
		<section class="settings-section">
			<SectionHeader
				icon={ModelIcon}
				title="Default model"
				description="The model a brand-new thread starts with. Any thread's model can still be switched from the composer."
				meta={settings.data?.effective.model}
			/>
			<Show when={settings.data}>
				{(data) => (
					<div class="settings-card">
						<div class="settings-field">
							<label class="settings-field-label" for="relay-default-model">
								Model for new threads
							</label>
							<select
								id="relay-default-model"
								class="input settings-select"
								value={`${preset()}::${model()}`}
								onChange={(event) => {
									const [nextPreset = DEFAULT_PRESET, nextModel = ""] =
										event.currentTarget.value.split("::");
									setPreset(nextPreset);
									setModel(nextModel);
									setStatus("");
									setError("");
								}}
							>
								<option value={`${DEFAULT_PRESET}::`}>Server default</option>
								<Show when={data().llm.preset === CUSTOM_PRESET}>
									<option value={`${CUSTOM_PRESET}::`}>Custom endpoint (advanced)</option>
								</Show>
								<For each={modelGroups()}>
									{(group) => (
										<optgroup label={group.label}>
											<For each={group.models}>
												{(entry) => (
													<option value={`${group.preset}::${entry.id}`}>
														{entry.label}
													</option>
												)}
											</For>
										</optgroup>
									)}
								</For>
							</select>
						</div>
						<div class="settings-effective">
							<span class="settings-effective-label">Currently</span>
							<span class="settings-effective-value">{effectiveLabel()}</span>
						</div>
						<div class="settings-actions">
							<button
								type="button"
								class="btn primary"
								disabled={save.isPending}
								onClick={saveDefaultModel}
							>
								{save.isPending ? "Saving…" : "Save default"}
							</button>
						</div>
						<Show when={error()}>
							<p class="settings-error">{error()}</p>
						</Show>
						<Show when={!error() && status()}>
							<p class="settings-ok">{status()}</p>
						</Show>
					</div>
				)}
			</Show>
		</section>
	);
}

/* ------------------------------------------------------------------ */
/* Advanced · custom endpoint                                          */
/* ------------------------------------------------------------------ */

function AdvancedSection() {
	const settings = useQuery(() => settingsQuery);
	const invalidate = useInvalidateSettings();

	const [provider, setProvider] = createSignal<ProviderDraft>("openai");
	const [baseUrl, setBaseUrl] = createSignal("");
	const [model, setModel] = createSignal("");
	const [context, setContext] = createSignal("");
	const [apiKey, setApiKey] = createSignal("");
	const [status, setStatus] = createSignal("");
	const [error, setError] = createSignal("");

	let hydrated: SettingsResponse | undefined;
	createEffect(() => {
		const data = settings.data;
		if (!data || data === hydrated) return;
		hydrated = data;
		if (data.llm.preset === CUSTOM_PRESET) {
			setProvider(data.llm.provider === "anthropic" ? "anthropic" : "openai");
			setBaseUrl(data.llm.baseURL ?? "");
			setModel(data.llm.model ?? "");
			setContext(data.llm.contextTokens ? String(data.llm.contextTokens) : "");
		}
	});

	const save = useMutation(() => ({
		mutationFn: (request: UpdateSettingsRequest) => updateSettings(request),
		onSuccess: async () => {
			setApiKey("");
			setStatus("Saved. New threads use this endpoint.");
			setError("");
			await invalidate();
		},
		onError: (cause) => {
			setStatus("");
			setError(errorMessage(cause));
		},
	}));

	function saveEndpoint(): void {
		const tokenBudget = context().trim();
		save.mutate({
			preset: CUSTOM_PRESET,
			provider: provider(),
			baseURL: baseUrl().trim(),
			model: model().trim(),
			contextTokens: tokenBudget.length > 0 ? Number(tokenBudget) : null,
			...(apiKey().trim() ? { apiKey: apiKey().trim() } : {}),
		});
	}

	return (
		<section class="settings-section">
			<SectionHeader
				icon={AdvancedIcon}
				title="Custom endpoint"
				description="Point Relay at any OpenAI-compatible or Anthropic Messages endpoint. Saving here also makes it the default for new threads."
				meta="Advanced"
			/>
			<div class="settings-card">
				<div class="settings-form-grid">
					<div class="settings-field">
						<label class="settings-field-label" for="relay-provider">
							API family
						</label>
						<select
							id="relay-provider"
							class="input settings-select"
							value={provider()}
							onChange={(event) => setProvider(event.currentTarget.value as ProviderDraft)}
						>
							<option value="openai">OpenAI-compatible</option>
							<option value="anthropic">Anthropic Messages</option>
						</select>
					</div>
					<div class="settings-field">
						<label class="settings-field-label" for="relay-model-text">
							Model id
						</label>
						<input
							id="relay-model-text"
							class="input"
							placeholder="model-id"
							value={model()}
							onInput={(event) => setModel(event.currentTarget.value)}
						/>
					</div>
					<div class="settings-field wide">
						<label class="settings-field-label" for="relay-base-url">
							Base URL
						</label>
						<input
							id="relay-base-url"
							class="input"
							type="url"
							placeholder="https://example.com/v1"
							value={baseUrl()}
							onInput={(event) => setBaseUrl(event.currentTarget.value)}
						/>
					</div>
					<div class="settings-field">
						<label class="settings-field-label" for="relay-context">
							Context tokens (optional)
						</label>
						<input
							id="relay-context"
							class="input"
							type="number"
							min="4096"
							step="1024"
							placeholder="e.g. 128000"
							value={context()}
							onInput={(event) => setContext(event.currentTarget.value)}
						/>
					</div>
					<div class="settings-field">
						<label class="settings-field-label" for="relay-custom-key">
							API key
						</label>
						<input
							id="relay-custom-key"
							class="input"
							type="password"
							autocomplete="new-password"
							placeholder="Paste a key to replace the saved one"
							value={apiKey()}
							onInput={(event) => setApiKey(event.currentTarget.value)}
						/>
					</div>
				</div>
				<div class="settings-actions">
					<button
						type="button"
						class="btn primary"
						disabled={save.isPending || !baseUrl().trim() || !model().trim()}
						onClick={saveEndpoint}
					>
						{save.isPending ? "Saving…" : "Save endpoint"}
					</button>
				</div>
				<Show when={error()}>
					<p class="settings-error">{error()}</p>
				</Show>
				<Show when={!error() && status()}>
					<p class="settings-ok">{status()}</p>
				</Show>
			</div>
		</section>
	);
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

function SettingsPanel(props: { onBack: () => void }) {
	const navigate = useNavigate();
	const me = useQuery(() => meQuery);
	const settings = useQuery(() => settingsQuery);
	// Land on the tab that has work in it: a fresh account opens settings to
	// connect a subscription, everyone else starts on general preferences.
	const [tab, setTab] = createSignal<SettingsTab>(
		(settings.data?.connections.length ?? 0) > 0 ? "general" : "models",
	);
	let body: HTMLDivElement | undefined;

	const selectTab = (next: SettingsTab) => {
		setTab(next);
		body?.scrollTo({ top: 0 });
	};

	const onTabKeyDown = (event: KeyboardEvent) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		const next: SettingsTab = tab() === "general" ? "models" : "general";
		selectTab(next);
		document.getElementById(`settings-tab-${next}`)?.focus();
	};

	const connected = () => (settings.data?.connections.length ?? 0) > 0;

	// Auth seam: a 401 sends the user back through the boot/login flow.
	createEffect(() => {
		if (me.isError && me.error instanceof RelayError && me.error.status === 401) {
			void navigate({ to: "/", replace: true });
		}
	});

	return (
		<Show when={me.data} fallback={<BootScreen />}>
			{(user) => (
				<div class="settings">
					<header class="settings-header">
						<button type="button" class="settings-back" aria-label="Back to chat" onClick={props.onBack}>
							<BackIcon />
							<span>Back to chat</span>
						</button>
						<span class="settings-title">Settings</span>
						<span class="settings-version">v{VERSION}</span>
					</header>

					<div class="settings-tabs" role="tablist" aria-label="Settings sections" onKeyDown={onTabKeyDown}>
						<button
							type="button"
							role="tab"
							id="settings-tab-general"
							class="settings-tab"
							classList={{ active: tab() === "general" }}
							aria-selected={tab() === "general"}
							aria-controls="settings-panel-general"
							onClick={() => selectTab("general")}
						>
							General
						</button>
						<button
							type="button"
							role="tab"
							id="settings-tab-models"
							class="settings-tab"
							classList={{ active: tab() === "models" }}
							aria-selected={tab() === "models"}
							aria-controls="settings-panel-models"
							onClick={() => selectTab("models")}
						>
							Models
							<Show when={connected()}>
								<span class="settings-tab-dot" aria-hidden="true" />
							</Show>
						</button>
					</div>

					<div class="settings-body" ref={body}>
						<div
							class="settings-page"
							role="tabpanel"
							id="settings-panel-general"
							aria-labelledby="settings-tab-general"
							hidden={tab() !== "general"}
						>
							<div class="settings-grid settings-grid-stacked">
								<AccountSection user={user()} />
								<AppearanceSection />
							</div>
						</div>
						<div
							class="settings-page"
							role="tabpanel"
							id="settings-panel-models"
							aria-labelledby="settings-tab-models"
							hidden={tab() !== "models"}
						>
							<div class="settings-grid">
								<ConnectionsSection />
								<ModelSection />
								<Show when={settings.data?.canCustom}>
									<AdvancedSection />
								</Show>
							</div>
						</div>
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
				<button type="button" class="settings-back" aria-label="Back to chat" onClick={props.onBack}>
					<BackIcon />
					<span>Back to chat</span>
				</button>
				<span class="settings-title">Settings</span>
			</header>
			<div class="settings-body">
				<div class="settings-loading" role="status" aria-label="Loading settings">
					<span class="settings-loading-bar" />
				</div>
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
