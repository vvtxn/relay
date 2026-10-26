import { createEffect, onCleanup, Show } from "solid-js";
import { Outlet, useChildMatches, useNavigate, useParams } from "@tanstack/solid-router";
import { useQuery } from "@tanstack/solid-query";
import { configQuery, meQuery, sessionQuery } from "#/api/queries.ts";
import { RelayError } from "@vvtxn/client/services.ts";
import { signOut } from "#/auth/auth.ts";
import { AppShell } from "#/components/AppShell.tsx";
import { BootError, BootScreen } from "#/components/BootScreen.tsx";
import { ChatView } from "#/components/ChatView.tsx";
import { Composer } from "#/components/Composer.tsx";
import { DiffModal } from "#/components/DiffModal.tsx";
import { StatusBar } from "#/components/StatusBar.tsx";
import { ensureSession, startStream, stopStream } from "#/state/session.ts";
import { rememberWorkspace, setHomeDir } from "#/state/workspace.ts";
import { VERSION } from "#/version.ts";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function SessionPage() {
	const params = useParams({ from: "/s/$sessionId" });
	const navigate = useNavigate();
	const childMatches = useChildMatches();
	const sessionId = () => params().sessionId;

	const me = useQuery(() => meQuery);
	const config = useQuery(() => configQuery);
	const session = useQuery(() => sessionQuery(sessionId()));

	// The settings route renders on top of the chat; the chat stays mounted (and
	// its stream connected) so closing settings is instant and nothing is lost.
	const settingsOpen = () => childMatches().some((match) => match.routeId === "/s/$sessionId/settings");

	// Auth seam: a 401 sends the user back through the boot/login flow.
	createEffect(() => {
		if (me.isError && me.error instanceof RelayError && me.error.status === 401) {
			void navigate({ to: "/", replace: true });
		}
	});

	// A session can vanish or belong to another identity (e.g. after switching
	// the server auth subject). The route loader catches this first; this stays
	// as a backstop for errors raised after mount.
	createEffect(() => {
		if (session.isError) {
			void navigate({ to: "/", replace: true });
		}
	});

	createEffect(() => {
		const home = config.data?.home;
		if (home) setHomeDir(home);
	});

	// The open session's workspace is where the sidebar targets "New chat".
	createEffect(() => {
		const cwd = session.data?.header.cwd;
		if (cwd) rememberWorkspace(cwd);
	});

	// Seed persisted entries once per session, then keep the live stream as the
	// source of truth. Refetches must never reset state or restart the stream.
	createEffect(() => {
		const id = sessionId();
		const data = session.data;
		if (!id || !data) return;
		ensureSession(id, data);
		startStream(id);
	});

	onCleanup(stopStream);

	const goToSettings = () => {
		void navigate({ to: "/s/$sessionId/settings", params: { sessionId: sessionId() } });
	};

	return (
		<Show
			when={!me.isError && !config.isError}
			fallback={<BootError message={errorMessage(me.error ?? config.error)} />}
		>
			<Show when={me.data && config.data && session.data} fallback={<BootScreen />}>
				<AppShell
					userName={me.data!.name}
					avatarUrl={me.data!.avatarUrl}
					activeSessionId={sessionId()}
					activeWorkspace={session.data!.header.cwd}
					inert={settingsOpen()}
					onOpenSettings={goToSettings}
				>
					<StatusBar
						branch={session.data!.branch}
						box={session.data!.box}
						userName={me.data!.name}
						avatarUrl={me.data!.avatarUrl}
						canSignOut={me.data!.provider !== "local"}
						onSignOut={() => void signOut()}
					/>
					<ChatView model={config.data!.model} version={VERSION} />
					<Composer sessionId={sessionId()} />
					<DiffModal />
				</AppShell>
				<Outlet />
			</Show>
		</Show>
	);
}
