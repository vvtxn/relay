/**
 * @vvtxn/client — Typed client + wire protocol for the Relay server.
 *
 * Shared by the CLI (Deno) and the web app (browser) so the protocol is
 * defined exactly once.
 *
 * @example
 * ```ts
 * import { RelayClient } from "@vvtxn/client";
 *
 * const client = new RelayClient({ baseUrl: "http://127.0.0.1:7433" });
 * const { id } = await client.createSession("/path/to/project");
 * await client.sendMessage(id, "fix the failing test");
 * for await (const event of client.subscribe(id, abortController.signal)) {
 *     if (event.type === "text_delta") process.stdout.write(event.content);
 * }
 * ```
 *
 * @module
 */

export { RelayApiError, RelayClient } from "./client.ts";
export type { RelayClientOptions, SubscribeOptions } from "./client.ts";
export { encodeSSEFrame, readSSEStream } from "./sse.ts";
export {
	applyServerEvent,
	flushDraft,
	hasDraft,
	initialSessionStreamState,
	resetSessionStreamState,
	viewMessages,
} from "./session-state.ts";
export type { SessionStatus, SessionStreamState } from "./session-state.ts";
export type {
	ApprovalDecision,
	ApprovalRequest,
	AuthInfoResponse,
	ConfigResponse,
	CreateSessionRequest,
	CreateSessionResponse,
	ErrorResponse,
	FileListResponse,
	HealthResponse,
	MeResponse,
	OpenSessionResponse,
	PendingApprovalInfo,
	RunStateEvent,
	SendMessageRequest,
	SendMessageResponse,
	ServerEvent,
	SessionListResponse,
	StatusResponse,
	WorkspaceResponse,
} from "./protocol.ts";
