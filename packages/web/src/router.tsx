import { createRootRoute, createRoute, createRouter, Outlet, redirect } from "@tanstack/solid-router";
import { decodeWorkspaceToken } from "@vvtxn/relay/core/workspace-token.ts";
import { queryClient } from "#/api/query-client.ts";
import { sessionQuery, sessionsQuery, workspacesQuery } from "#/api/queries.ts";
import { BootScreen } from "#/components/BootScreen.tsx";
import { OverviewPage } from "#/pages/OverviewPage.tsx";
import { SessionPage } from "#/pages/SessionPage.tsx";
import { SessionSettingsRoute, SettingsPage } from "#/pages/SettingsPage.tsx";
import { WorkspacePage } from "#/pages/WorkspacePage.tsx";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

/** Root view: every workspace, plus a way back into the last chat. */
const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: OverviewPage,
});

const workspaceRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/w/$token",
	loader: {
		handler: async ({ params }) => {
			const cwd = decodeWorkspaceToken(params.token);
			if (!cwd) throw redirect({ to: "/" });
			// Warm the pane's data; `intent` preloading warms this on link hover,
			// so a workspace opens without a loading flash. Failures settle into
			// the page's own error states rather than the router's.
			await Promise.allSettled([
				queryClient.ensureQueryData(workspacesQuery),
				queryClient.ensureQueryData(sessionsQuery(cwd)),
			]);
			return { cwd };
		},
		staleReloadMode: "blocking",
		pendingMs: Infinity,
	},
	component: WorkspacePage,
});

const sessionRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/s/$sessionId",
	loader: {
		// Ensure a fresh persisted snapshot before the route renders (no loading
		// flash, and `intent` preloading warms this on link hover). Fresh cache
		// entries — a just-created session, or one still streaming — resolve
		// without a request; a detached session is refetched because its stream
		// is the only thing that saw events while it was away.
		handler: async ({ params }) => {
			try {
				return await queryClient.fetchQuery(sessionQuery(params.sessionId));
			} catch {
				// Missing, foreign, or unauthorized sessions reopen through boot.
				throw redirect({ to: "/" });
			}
		},
		// Wait for that snapshot instead of committing with the router's own
		// cached loader data and refreshing in the background.
		staleReloadMode: "blocking",
		// Slow loads keep the current view; only a cold app start falls back to
		// the router's pending component.
		pendingMs: Infinity,
	},
	component: SessionPage,
});

const sessionSettingsRoute = createRoute({
	getParentRoute: () => sessionRoute,
	path: "settings",
	component: SessionSettingsRoute,
});

const settingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings",
	component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
	indexRoute,
	workspaceRoute,
	sessionRoute.addChildren([sessionSettingsRoute]),
	settingsRoute,
]);

export const router = createRouter({
	routeTree,
	defaultPreload: "intent",
	// Branded fallback for cold loads; navigations keep the current view until
	// their loader resolves (no blank frame in between).
	defaultPendingComponent: BootScreen,
});

declare module "@tanstack/solid-router" {
	interface Register {
		router: typeof router;
	}
}
