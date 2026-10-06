import { createEffect, createSignal, Show } from "solid-js";
import { useNavigate } from "@tanstack/solid-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query";
import { meQuery, settingsQuery } from "@/api/queries.ts";
import { setApiKey } from "@/api/mutations.ts";
import { RelayError } from "@/api/services.ts";
import { queryKeys } from "@/api/query-client.ts";
import { signOut } from "@/auth/auth.ts";
import { BootScreen } from "@/components/BootScreen.tsx";
import { setTheme, theme } from "@/state/theme.ts";
import { VERSION } from "@/version.ts";

export function SettingsPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const me = useQuery(() => meQuery);
	const settings = useQuery(() => settingsQuery);
	const [draftKey, setDraftKey] = createSignal("");
	const [message, setMessage] = createSignal("");
	const [error, setError] = createSignal("");

	// Auth seam: a 401 sends the user back through the boot/login flow.
	createEffect(() => {
		if (me.isError && me.error instanceof RelayError && me.error.status === 401) {
			void navigate({ to: "/", replace: true });
		}
	});

	const save = useMutation(() => ({
		mutationFn: (apiKey: string | null) => setApiKey(apiKey),
		onSuccess: async () => {
			setDraftKey("");
			setMessage("Saved.");
			setError("");
			await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
		},
		onError: (err) => {
			setMessage("");
			setError(err instanceof Error ? err.message : String(err));
		},
	}));

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		const value = draftKey().trim();
		if (!value) return;
		save.mutate(value);
	}

	return (
		<Show when={me.data} fallback={<BootScreen />}>
			{(user) => (
				<div class="settings">
					<header class="settings-header">
						<button type="button" class="status-action" onClick={() => void navigate({ to: "/" })}>
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
										{user().provider ? `signed in via ${user().provider}` : "signed in"}
									</span>
								</div>
							</div>
							<div class="settings-actions">
								<button type="button" class="btn" onClick={() => void signOut()}>
									Sign out
								</button>
							</div>
						</section>

						<section class="settings-section">
							<h2 class="settings-section-title">Appearance</h2>
							<div class="settings-row">
								<span class="settings-label">Theme</span>
								<div class="theme-toggle">
									<button
										type="button"
										class={theme() === "dark" ? "theme-option active" : "theme-option"}
										onClick={() => setTheme("dark")}
									>
										Dark
									</button>
									<button
										type="button"
										class={theme() === "light" ? "theme-option active" : "theme-option"}
										onClick={() => setTheme("light")}
									>
										Light
									</button>
								</div>
							</div>
							<p class="settings-hint">Stored in this browser.</p>
						</section>

						<section class="settings-section">
							<h2 class="settings-section-title">API key</h2>
							<p class="settings-hint">
								Used by the server to call the model on your behalf. Stored per account and never shown
								again.
							</p>
							<div class="settings-row">
								<span class="settings-label">Status</span>
								<span class="settings-value">
									<Show
										when={settings.data?.apiKey.set}
										fallback={<span class="settings-empty">not set</span>}
									>
										set (••••{settings.data?.apiKey.hint})
									</Show>
								</span>
							</div>
							<form class="settings-form" onSubmit={submit}>
								<input
									class="input"
									type="password"
									autocomplete="off"
									placeholder="Paste your API key"
									value={draftKey()}
									onInput={(event) => setDraftKey(event.currentTarget.value)}
								/>
								<div class="settings-actions">
									<button
										type="submit"
										class="btn primary"
										disabled={save.isPending || !draftKey().trim()}
									>
										{save.isPending ? "Saving…" : "Save"}
									</button>
									<Show when={settings.data?.apiKey.set}>
										<button
											type="button"
											class="btn danger"
											disabled={save.isPending}
											onClick={() => save.mutate(null)}
										>
											Clear
										</button>
									</Show>
								</div>
							</form>
							<Show when={error()}>
								<p class="settings-error">{error()}</p>
							</Show>
							<Show when={!error() && message()}>
								<p class="settings-ok">{message()}</p>
							</Show>
						</section>
					</div>
				</div>
			)}
		</Show>
	);
}
