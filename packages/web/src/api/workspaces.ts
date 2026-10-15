import { registerWorkspace, validateWorkspace } from "#/api/mutations.ts";
import { queryClient, queryKeys } from "#/api/query-client.ts";

export type AddWorkspaceResult = { ok: true; path: string } | { ok: false; message: string };

/**
 * Validate and register a workspace directory. `input` is the user's raw entry
 * (absolute path or `~`-prefixed); the server canonicalizes it and enforces its
 * workspace roots. Returns the canonical path on success.
 */
export async function addWorkspace(input: string): Promise<AddWorkspaceResult> {
	try {
		const validation = await validateWorkspace(input);
		if (!validation.ok || !validation.path) {
			return { ok: false, message: validation.message ?? "That workspace cannot be used." };
		}
		await registerWorkspace(validation.path);
		await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
		return { ok: true, path: validation.path };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}
