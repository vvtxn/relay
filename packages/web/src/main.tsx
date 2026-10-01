import { render } from "solid-js/web";
import { QueryClientProvider } from "@tanstack/solid-query";
import { RouterProvider } from "@tanstack/solid-router";
import { queryClient } from "@/api/query-client.ts";
import { router } from "@/router.tsx";
import { applyTheme } from "@/theme.ts";
import "./styles.css";

applyTheme();

const root = document.getElementById("root");
if (root) {
	render(
		() => (
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>
		),
		root,
	);
}
