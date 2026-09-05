import type { CommandPaletteItem } from "@/tui/render/hooks/command-palette.ts";
import { useSignal } from "@/tui/render/hooks/signals.ts";
import { client } from "../client.ts";

/**
 * Project file listing for the @-mention picker, served by the Relay server
 * (the server owns the workspace filesystem). Cached per session.
 */
export function useProjectFiles(getSessionId: () => string | null) {
	const files = useSignal<CommandPaletteItem[]>([]);
	const status = useSignal<"idle" | "indexing" | "ready" | "error">("idle");
	const generation = useSignal(0);
	const cachedSession = useSignal<string | null>(null);

	const startIndexing = () => {
		const id = getSessionId();
		if (!id || status.value === "indexing") return;
		if (cachedSession.value === id && status.value === "ready") return;
		status.value = "indexing";
		const gen = ++generation.value;

		void (async () => {
			try {
				const response = await client.listFiles(id);
				if (gen !== generation.value) return;
				files.value = response.files.map((p) => ({ id: p, title: p }));
				cachedSession.value = id;
				status.value = "ready";
			} catch {
				if (gen !== generation.value) return;
				status.value = "error";
			}
		})();
	};

	const cancelIndexing = () => {
		generation.value++;
	};

	return { files, status, startIndexing, cancelIndexing };
}
