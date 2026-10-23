import { profileForSettings } from "@vvtxn/box/profiles.ts";
import type { BoxStatus } from "@vvtxn/box/types.ts";
import type { BoxSummary } from "@vvtxn/client/protocol.ts";

/** Project a manager status onto the public wire shape. */
export function boxSummary(status: BoxStatus): BoxSummary {
	return {
		boxId: status.boxId,
		state: status.state,
		profile: profileForSettings(status.settings),
		cpus: status.settings.cpus,
		memoryMiB: status.settings.memoryMiB,
		rootDiskMiB: status.settings.rootDiskMiB,
		attachments: status.attachments.map((attachment) => attachment.sessionId),
		...(status.originSessionId ? { originSessionId: status.originSessionId } : {}),
		createdAt: status.createdAt,
		lastUsedAt: status.lastUsedAt,
		...(status.pausedAt ? { pausedAt: status.pausedAt } : {}),
		...(status.error ? { error: status.error } : {}),
		...(status.capacity ? { capacity: status.capacity } : {}),
	};
}
