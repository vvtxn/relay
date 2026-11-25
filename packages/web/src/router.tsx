import {
	createRootRoute,
	createRoute,
	createRouter,
	lazyRouteComponent,
	Link,
	Outlet,
	redirect,
} from "@tanstack/solid-router";
import { decodeWorkspaceToken } from "@vvtxn/relay/core/workspace-token.ts";
import { RelayError } from "@vvtxn/client/services.ts";
import { queryClient } from "#/api/query-client.ts";
import {
	configQuery,
	meQuery,
	modelCatalogQuery,
	sessionQuery,
	sessionsQuery,
	settingsQuery,
	workspaceQuery,
	workspacesQuery,
} from "#/api/queries.ts";
import { BootScreen } from "#/components/BootScreen.tsx";
import { OverviewPage } from "#/pages/OverviewPage.tsx";
import { SessionSettingsRoute, SettingsPage } from "#/pages/SettingsPage.tsx";
import { WorkspacePage } from "#/pages/WorkspacePage.tsx";

/**
 * The chat surface is the only consumer of markdown-it, Shiki, and
 * `@pierre/diffs` (~470 KB minified). Loading it lazily keeps that weight out of
 * the boot/overview/login chunk; the router's `intent` preloading fetches it on
 * link hover, and the route loader still commits only once it is ready.
 */
const SessionPage = lazyRouteComponent(() => import("#/pages/SessionPage.tsx"), "SessionPage");

const rootRoute = createRootRoute({ component: () => <Outlet /> });

/**
 * Warm every query the settings panel reads (identity, per-user settings, and
 * the Models tab's catalog) before either settings route commits, so the
 * panel never suspends into its fallback on navigation.
 */
async function warmSettingsRoute(): Promise<void> {
	await Promise.allSettled([
		queryClient.ensureQueryData(meQuery),
		queryClient.ensureQueryData(settingsQuery),
		queryClient.ensureQueryData(modelCatalogQuery),
	]);
}

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
			// Warm the shell and pane data; `intent` preloading warms this on link
			// hover, so a workspace opens without a loading flash. Failures settle
			// into the page's own error states rather than the router's.
			await Promise.allSettled([
				queryClient.ensureQueryData(meQuery),
				queryClient.ensureQueryData(configQuery),
				queryClient.ensureQueryData(workspaceQuery),
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
			// Warm everything the shell reads before the route commits. Solid's
			// resource-backed queries suspend the nearest Suspense boundary while
			// their data is undefined, and the router's boundary fallback is the
			// full-screen BootScreen. With these seeded, the first render after a
			// navigation has no pending resources, so background stream events,
			// polling refetches, or popover first-opens cannot flash the boot
			// screen mid-transition.
			const shell = Promise.allSettled([
				queryClient.ensureQueryData(meQuery),
				queryClient.ensureQueryData(configQuery),
				queryClient.ensureQueryData(workspaceQuery),
				queryClient.ensureQueryData(workspacesQuery),
			]);
			const query = sessionQuery(params.sessionId);
			try {
				const session = await queryClient.fetchQuery(query);
				const cwd = session.header.cwd;
				if (cwd) {
					await Promise.all([shell, queryClient.ensureQueryData(sessionsQuery(cwd))]);
				} else {
					await shell;
				}
				return session;
			} catch (error) {
				// Only a genuinely lost credential bounces through boot. When a
				// snapshot exists, keep rendering it: a transient refetch failure
				// must not eject the user (or an open settings overlay) to the root.
				const cached = queryClient.getQueryData(query.queryKey);
				if (cached) return cached;
				if (error instanceof RelayError && error.status === 401) throw redirect({ to: "/" });
				throw error;
			}
		},
		// Wait for that snapshot instead of committing with the router's own
		// cached loader data and refreshing in the background.
		staleReloadMode: "blocking",
		// Slow loads keep the current view; only a cold app start falls back to
		// the router's pending component.
		pendingMs: Infinity,
	},
	errorComponent: SessionRouteError,
	component: SessionPage,
});

function SessionRouteError(props: { error: Error }) {
	return (
		<div class="boot">
			<div class="boot-card boot-card-error">
				<div class="boot-brand">
					<div class="boot-logo">RELAY</div>
					<div class="boot-tagline">coding agent</div>
				</div>
				<div class="boot-error-title">This thread can't be opened</div>
				<div class="boot-error-message">{props.error.message}</div>
				<ul class="boot-hints">
					<li>It may have been removed by the server's thread limit.</li>
					<li>Or the server could not be reached for a moment.</li>
				</ul>
				<div class="boot-actions">
					<Link to="/" class="btn primary">
						Back to workspaces
					</Link>
				</div>
			</div>
		</div>
	);
}

const sessionSettingsRoute = createRoute({
	getParentRoute: () => sessionRoute,
	path: "settings",
	loader: {
		// Warm the overlay's data before it commits so opening it from a thread
		// never shows the Suspense fallback.
		handler: () => warmSettingsRoute(),
	},
	component: SessionSettingsRoute,
});

const settingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings",
	loader: {
		// Standalone settings (CLI deep links, workspace/session entry points).
		handler: () => warmSettingsRoute(),
	},
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
