import type {
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
	SendMessageRequest,
	SendMessageResponse,
	ServerEvent,
	SessionListResponse,
	StatusResponse,
	WorkspaceResponse,
} from "./protocol.ts";
import { readSSEStream } from "./sse.ts";

/** Error thrown for non-2xx API responses; carries the server's error message. */
export class RelayApiError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "RelayApiError";
	}
}

export interface RelayClientOptions {
	/** Base URL of the Relay server, e.g. "http://127.0.0.1:7433". */
	baseUrl: string;
	/** Optional fetch override (testing, auth wrappers). */
	fetch?: typeof fetch;
}

/**
 * Typed client for the Relay server API. Pure fetch — no runtime-specific
 * dependencies, so the same client drives the CLI (Deno) and the web app
 * (browser).
 */

export interface SubscribeOptions {
	/** Aborts the subscription when fired. */
	signal?: AbortSignal;
	/** Called once the SSE response is established, before any events flow. */
	onOpen?: () => void;
}

export class RelayClient {
	private readonly baseUrl: string;
	private readonly doFetch: typeof fetch;

	constructor(options: RelayClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.doFetch = options.fetch ?? fetch;
	}

	async health(): Promise<HealthResponse> {
		return await this.get("/api/health");
	}

	async me(): Promise<MeResponse> {
		return await this.get("/api/me");
	}

	async workspace(): Promise<WorkspaceResponse> {
		return await this.get("/api/workspace");
	}

	async getConfig(): Promise<ConfigResponse> {
		return await this.get("/api/config");
	}

	async getAuthInfo(): Promise<AuthInfoResponse> {
		return await this.get("/api/auth/info");
	}

	async listSessions(cwd: string): Promise<SessionListResponse> {
		return await this.get(`/api/sessions?cwd=${encodeURIComponent(cwd)}`);
	}

	async createSession(cwd: string): Promise<CreateSessionResponse> {
		return await this.post("/api/sessions", { cwd } satisfies CreateSessionRequest);
	}

	async openSession(id: string): Promise<OpenSessionResponse> {
		return await this.get(`/api/sessions/${id}`);
	}

	async listFiles(sessionId: string): Promise<FileListResponse> {
		return await this.get(`/api/sessions/${sessionId}/files`);
	}

	async sendMessage(sessionId: string, content: string): Promise<SendMessageResponse> {
		return await this.post(`/api/sessions/${sessionId}/messages`, { content } satisfies SendMessageRequest);
	}

	async approve(sessionId: string, toolCallId: string, decision: ApprovalDecision): Promise<StatusResponse> {
		return await this.post(
			`/api/sessions/${sessionId}/approve`,
			{ toolCallId, decision } satisfies ApprovalRequest,
		);
	}

	async cancel(sessionId: string): Promise<StatusResponse> {
		return await this.post(`/api/sessions/${sessionId}/cancel`, {});
	}

	/**
	 * Subscribe to a session's SSE event stream. The stream ends when the
	 * server closes it (session idle shutdown) or the signal aborts.
	 */
	async *subscribe(sessionId: string, options: SubscribeOptions | AbortSignal = {}): AsyncIterable<ServerEvent> {
		const { signal, onOpen } = options instanceof AbortSignal ? { signal: options, onOpen: undefined } : options;
		const response = await this.doFetch(`${this.baseUrl}/api/sessions/${sessionId}/events`, {
			signal: signal ?? null,
		});
		if (!response.ok) throw await this.toError(response);
		onOpen?.();
		yield* readSSEStream<ServerEvent>(response);
	}

	private async get(path: string): Promise<any> {
		const response = await this.doFetch(`${this.baseUrl}${path}`);
		if (!response.ok) throw await this.toError(response);
		return await response.json();
	}

	private async post(path: string, body: unknown): Promise<any> {
		const response = await this.doFetch(`${this.baseUrl}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok) throw await this.toError(response);
		return await response.json();
	}

	private async toError(response: Response): Promise<RelayApiError> {
		const text = await response.text().catch(() => "");
		let message = text || response.statusText;
		try {
			const parsed = JSON.parse(text) as ErrorResponse;
			if (typeof parsed.error === "string") message = parsed.error;
		} catch { /* not JSON — use raw text */ }
		return new RelayApiError(response.status, message);
	}
}
