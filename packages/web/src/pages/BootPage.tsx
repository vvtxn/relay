import { createEffect, createResource, Show } from "solid-js";
import { useNavigate } from "@tanstack/solid-router";
import { bootstrap } from "@/api/bootstrap.ts";
import { queryClient, queryKeys } from "@/api/query-client.ts";
import { runtime } from "@/api/runtime.ts";
import { beginLogin } from "@/auth/auth.ts";
import { BootError, BootScreen, LoginScreen } from "@/components/BootScreen.tsx";
import { setCwd } from "@/state/workspace.ts";

export function BootPage() {
	const navigate = useNavigate();
	const [result] = createResource(() => runtime.runPromise(bootstrap));

	createEffect(() => {
		const boot = result();
		if (!boot || boot.kind !== "ready") return;
		setCwd(boot.cwd);
		queryClient.setQueryData(queryKeys.me, boot.me);
		queryClient.setQueryData(queryKeys.config, boot.config);
		void navigate({ to: "/s/$sessionId", params: { sessionId: boot.sessionId }, replace: true });
	});

	return (
		<Show when={!result.loading} fallback={<BootScreen />}>
			<Show when={result.error}>{(error) => <BootError message={toMessage(error())} />}</Show>
			<Show when={result()?.kind === "unauthenticated"}>
				<LoginScreen onLogin={beginLogin} />
			</Show>
			<Show when={result()?.kind === "ready"}>
				<BootScreen />
			</Show>
		</Show>
	);
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
