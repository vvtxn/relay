import type { JSX } from "solid-js";
import { Sidebar } from "#/components/Sidebar.tsx";

/**
 * The authenticated app frame shared by every page: the workspace sidebar next
 * to a page-owned main pane. `inert` lets the session page freeze the frame
 * while its settings overlay is open.
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
			<Sidebar
				userName={props.userName}
				avatarUrl={props.avatarUrl}
				activeSessionId={props.activeSessionId}
				activeWorkspace={props.activeWorkspace}
				onOpenSettings={props.onOpenSettings}
			/>
			<main class="main">{props.children}</main>
		</div>
	);
}
