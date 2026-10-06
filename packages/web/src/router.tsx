import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/solid-router";
import { BootPage } from "@/pages/BootPage.tsx";
import { SessionPage } from "@/pages/SessionPage.tsx";
import { SettingsPage } from "@/pages/SettingsPage.tsx";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: BootPage,
});

const sessionRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/s/$sessionId",
	component: SessionPage,
});

const settingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/settings",
	component: SettingsPage,
});

const routeTree = rootRoute.addChildren([indexRoute, sessionRoute, settingsRoute]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/solid-router" {
	interface Register {
		router: typeof router;
	}
}
