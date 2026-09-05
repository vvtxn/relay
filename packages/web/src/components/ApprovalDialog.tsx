import type { PendingApprovalInfo } from "@vvtxn/client/protocol.ts";
import { getToolDisplayName } from "@vvtxn/relay/core/display.ts";
import { resolveApproval } from "../state.ts";

export function ApprovalDialog({ approval }: { approval: PendingApprovalInfo | null }) {
	if (!approval) return null;

	return (
		<div class="approval-overlay">
			<div class="approval-card">
				<div class="approval-title">
					Allow <b>{getToolDisplayName(approval.toolName)}</b>?
				</div>
				<div class="approval-summary">{approval.summary}</div>
				<div class="approval-actions">
					<button type="button" class="btn primary" onClick={() => void resolveApproval("allow")}>
						Allow
					</button>
					<button type="button" class="btn" onClick={() => void resolveApproval("always")}>
						Always allow
					</button>
					<button type="button" class="btn danger" onClick={() => void resolveApproval("deny")}>Deny</button>
				</div>
			</div>
		</div>
	);
}
