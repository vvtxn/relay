import { createEffect, onCleanup, Show } from "solid-js";
import { useNavigate, useParams } from "@tanstack/solid-router";
import { useQuery } from "@tanstack/solid-query";
import { configQuery, meQuery, sessionQuery } from "@/api/queries.ts";
import { RelayError } from "@/api/services.ts";
import { signOut } from "@/auth/auth.ts";
import { ApprovalDialog } from "@/components/ApprovalDialog.tsx";
import { BootError, BootScreen } from "@/components/BootScreen.tsx";
import { ChatView } from "@/components/ChatView.tsx";
import { Composer } from "@/components/Composer.tsx";
import { Sidebar } from "@/components/Sidebar.tsx";
import { StatusBar } from "@/components/StatusBar.tsx";
import { hydrateSession, resetSession, startStream, stopStream } from "@/state/session.ts";
import { setHomeDir } from "@/state/workspace.ts";
import { VERSION } from "@/version.ts";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function SessionPage() {
	const params = useParams({ from: "/s/$sessionId" });
	const navigate = useNavigate();
	const sessionId = () => params().sessionId;

	const me = useQuery(() => meQuery);
	const config = useQuery(() => configQuery);
	const session = useQuery(() => sessionQuery(sessionId()));

	// Auth seam: a 401 sends the user back through the boot/login flow.
	createEffect(() => {
		if (me.isError && me.error instanceof RelayError && me.error.status === 401) {
			void navigate({ to: "/", replace: true });
		}
	});

	// A session can vanish or belong to another identity (e.g. after switching
	// the server auth subject). Send the user back to boot, which opens a valid
	// session for the current user, instead of hanging on the loading screen.
	createEffect(() => {
		if (session.isError) {
			void navigate({ to: "/", replace: true });
		}
	});

	createEffect(() => {
		const home = config.data?.home;
		if (home) setHomeDir(home);
	});

	// Load persisted entries first, then attach the live stream so the run_state
	// snapshot is not clobbered by hydration.
	createEffect(() => {
		const id = sessionId();
		const data = session.data;
		if (!id || !data) return;
		resetSession();
		hydrateSession(data.entries, data.tokens, data.cost);
		startStream(id);
		onCleanup(stopStream);
	});

	const goToSession = (id: string) => {
		void navigate({ to: "/s/$sessionId", params: { sessionId: id } });
	};

	return (
		<Show
			when={!me.isError && !config.isError}
			fallback={<BootError message={errorMessage(me.error ?? config.error)} />}
		>
			<Show when={me.data && config.data && session.data} fallback={<BootScreen />}>
				<div class="app">
					<Sidebar
						userName={me.data!.name}
						avatarUrl={me.data!.avatarUrl}
						activeSessionId={sessionId()}
						onSelect={goToSession}
					/>
					<main class="main">
						<StatusBar
							model={config.data!.model}
							branch={session.data!.branch}
							userName={me.data!.name}
							avatarUrl={me.data!.avatarUrl}
							contextWindow={config.data!.contextTokens}
							onSignOut={() => void signOut()}
						/>
						<ChatView model={config.data!.model} version={VERSION} />
						<Composer sessionId={sessionId()} />
						<ApprovalDialog sessionId={sessionId()} />
					</main>
				</div>
			</Show>
		</Show>
	);
}
