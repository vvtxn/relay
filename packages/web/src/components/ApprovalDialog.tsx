import { Show } from "solid-js";
import { useMutation } from "@tanstack/solid-query";
import { getToolDisplayName } from "@vvtxn/relay/core/display.ts";
import type { ApprovalDecision } from "@vvtxn/client/protocol.ts";
import { approve } from "@/api/mutations.ts";
import { appendError, streamState } from "@/state/session.ts";

export function ApprovalDialog(props: { sessionId: string }) {
	const approval = () => streamState().pendingApproval;

	const decide = useMutation(() => ({
		mutationFn: (decision: ApprovalDecision) => {
			const pending = approval();
			if (!pending) throw new Error("No pending approval");
			return approve(props.sessionId, pending.toolCallId, decision);
		},
		onError: (error) => appendError(error instanceof Error ? error.message : String(error)),
	}));

	return (
		<Show when={approval()}>
			{(pending) => (
				<div class="overlay">
					<div class="dialog">
						<div class="dialog-title">Approval required</div>
						<div class="dialog-tool">{getToolDisplayName(pending().toolName)}</div>
						<div class="dialog-summary">{pending().summary}</div>
						<div class="dialog-actions">
							<button type="button" class="btn" onClick={() => decide.mutate("allow")}>Allow once</button>
							<button type="button" class="btn primary" onClick={() => decide.mutate("always")}>
								Always allow
							</button>
							<button type="button" class="btn danger" onClick={() => decide.mutate("deny")}>Deny</button>
						</div>
					</div>
				</div>
			)}
		</Show>
	);
}
