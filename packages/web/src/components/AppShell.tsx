import { Suspense } from "solid-js";
import type { JSX } from "solid-js";
import { Sidebar } from "#/components/Sidebar.tsx";

/**
 * The authenticated app frame shared by every page: the workspace sidebar next
 * to a page-owned main pane. `inert` lets the session page freeze the frame
 * while its settings overlay is open.
 *
 * The sidebar gets its own Suspense boundary so a first-fetch query inside it
 * (expanding a workspace, a stale refetch) suspends the sidebar instead of the
 * router's match boundary — whose fallback is the full-screen BootScreen.
 * It must wrap the component invocation itself: Solid attributes a resource's
 * suspension to the owner that created the reading memo, so a boundary inside
 * the component would be too late.
 */
export function AppShell(props: {
	userName?: string | undefined;
	avatarUrl?: string | undefined;
	activeSessionId: string | null;
	activeWorkspace: string | null;
	inert?: boolean;
	onOpenSettings: () => void;
	children: JSX.Element;
}) {
	return (
		<div class="app" inert={props.inert}>
			<Suspense fallback={<aside class="sidebar" />}>
				<Sidebar
					userName={props.userName}
					avatarUrl={props.avatarUrl}
					activeSessionId={props.activeSessionId}
					activeWorkspace={props.activeWorkspace}
					onOpenSettings={props.onOpenSettings}
				/>
			</Suspense>
			<main class="main">{props.children}</main>
		</div>
	);
}
