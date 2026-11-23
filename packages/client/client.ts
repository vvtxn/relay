import type {
	BoxListResponse,
	BoxProfileName,
	BoxResizeRequest,
	BoxResponse,
	ConfigResponse,
	CreateBoxRequest,
	CreateSessionRequest,
	CreateSessionResponse,
	ErrorResponse,
	FileListResponse,
	HealthResponse,
	MeResponse,
	ModelCatalogResponse,
	ModelsResponse,
	OpenSessionResponse,
	OAuthCompleteRequest,
	OAuthCompleteResponse,
	OAuthStartResponse,
	RegisterWorkspaceRequest,
	RegisterWorkspaceResponse,
	RunListResponse,
	SendMessageRequest,
	SendMessageResponse,
	ServerEvent,
	SessionListResponse,
	SetConnectionRequest,
	SetConnectionResponse,
	SettingsResponse,
	StatusResponse,
	UpdateSettingsRequest,
	WorkspaceResponse,
	WorkspacesResponse,
	WorkspaceValidateResponse,
} from "./protocol.ts";
import { readSSEStream } from "./sse.ts";

/** Error thrown for non-2xx API responses; carries the server's error message. */
export class RelayApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
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
 * dependencies, so the same client drives the CLI (Node) and the web app
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

	async getSettings(): Promise<SettingsResponse> {
		return await this.get("/api/settings");
	}

	/** Set or (with null) clear the caller's LLM API key. */
	async setApiKey(apiKey: string | null): Promise<StatusResponse> {
		return await this.updateSettings({ apiKey });
	}

	/** Save the caller's LLM selection and/or API key. Omitted fields are kept. */
	async updateSettings(settings: UpdateSettingsRequest): Promise<StatusResponse> {
		return await this.put("/api/settings", settings);
	}

	/** Models offered by one preset; the server fills the list from the catalog. */
	async listModels(preset: string): Promise<ModelsResponse> {
		return await this.get(`/api/models?preset=${encodeURIComponent(preset)}`);
	}

	/** Models offered by every connected subscription, for the thread selector. */
	async listModelCatalog(): Promise<ModelCatalogResponse> {
		return await this.get("/api/models");
	}

	/** Starts a subscription sign-in and returns the provider URL. */
	async startOAuth(provider: string): Promise<OAuthStartResponse> {
		return await this.get(`/api/oauth/${encodeURIComponent(provider)}/start`);
	}

	/** Completes the paste flow (Claude) with the provider-displayed code. */
	async completeOAuth(provider: string, code: string): Promise<OAuthCompleteResponse> {
		return await this.post(`/api/oauth/${encodeURIComponent(provider)}/complete`, {
			code,
		} satisfies OAuthCompleteRequest);
	}

	/** Removes a subscription connection. */
	async disconnectOAuth(provider: string): Promise<OAuthCompleteResponse> {
		return await this.delete(`/api/oauth/${encodeURIComponent(provider)}`);
	}

	/** Abandons a pending subscription sign-in (closes the loopback listener). */
	async cancelOAuth(provider: string): Promise<StatusResponse> {
		return await this.delete(`/api/oauth/${encodeURIComponent(provider)}/pending`);
	}

	/** Stores an API key for a preset connection without touching the default. */
	async setConnection(preset: string, apiKey: string): Promise<SetConnectionResponse> {
		return await this.put(`/api/connections/${encodeURIComponent(preset)}`, {
			apiKey,
		} satisfies SetConnectionRequest);
	}

	/** Removes a preset's stored credential. */
	async removeConnection(preset: string): Promise<SetConnectionResponse> {
		return await this.delete(`/api/connections/${encodeURIComponent(preset)}`);
	}

	async listSessions(cwd: string): Promise<SessionListResponse> {
		return await this.get(`/api/sessions?cwd=${encodeURIComponent(cwd)}`);
	}

	/** Active runs across the caller's threads. */
	async listRuns(): Promise<RunListResponse> {
		return await this.get("/api/runs");
	}

	async listWorkspaces(): Promise<WorkspacesResponse> {
		return await this.get("/api/workspaces");
	}

	/** Validate a candidate workspace path without creating anything. */
	async validateWorkspace(cwd: string): Promise<WorkspaceValidateResponse> {
		return await this.get(`/api/workspaces/validate?cwd=${encodeURIComponent(cwd)}`);
	}

	/** Register a workspace so it appears in the picker before its first session. */
	async registerWorkspace(cwd: string): Promise<RegisterWorkspaceResponse> {
		return await this.post("/api/workspaces", { cwd } satisfies RegisterWorkspaceRequest);
	}

	/** Remove a workspace registration (its sessions are left intact). */
	async unregisterWorkspace(cwd: string): Promise<StatusResponse> {
		return await this.delete(`/api/workspaces?cwd=${encodeURIComponent(cwd)}`);
	}

	async createSession(cwd: string, options: { forceNew?: boolean } = {}): Promise<CreateSessionResponse> {
		return await this.post("/api/sessions", {
			cwd,
			...(options.forceNew ? { forceNew: true } : {}),
		} satisfies CreateSessionRequest);
	}

	async openSession(id: string): Promise<OpenSessionResponse> {
		return await this.get(`/api/sessions/${id}`);
	}

	async listFiles(sessionId: string): Promise<FileListResponse> {
		return await this.get(`/api/sessions/${sessionId}/files`);
	}

	async listBoxes(): Promise<BoxListResponse> {
		return await this.get("/api/boxes");
	}

	async createBox(cwd?: string, profile?: BoxProfileName): Promise<BoxResponse> {
		return await this.post("/api/boxes", {
			...(cwd ? { cwd } : {}),
			...(profile ? { profile } : {}),
		} satisfies CreateBoxRequest);
	}

	async getBox(boxId: string): Promise<BoxResponse> {
		return await this.get(`/api/boxes/${encodeURIComponent(boxId)}`);
	}

	async resizeBox(boxId: string, profile: BoxProfileName): Promise<BoxResponse> {
		return await this.post(`/api/boxes/${encodeURIComponent(boxId)}/resize`, {
			profile,
		} satisfies BoxResizeRequest);
	}

	async pauseBox(boxId: string): Promise<StatusResponse> {
		return await this.post(`/api/boxes/${encodeURIComponent(boxId)}/pause`, {});
	}

	async resumeBox(boxId: string): Promise<StatusResponse> {
		return await this.post(`/api/boxes/${encodeURIComponent(boxId)}/resume`, {});
	}

	async stopBox(boxId: string): Promise<StatusResponse> {
		return await this.post(`/api/boxes/${encodeURIComponent(boxId)}/stop`, {});
	}

	async removeBox(boxId: string): Promise<StatusResponse> {
		return await this.delete(`/api/boxes/${encodeURIComponent(boxId)}`);
	}

	async sendMessage(
		sessionId: string,
		content: string,
		model?: SendMessageRequest["model"],
	): Promise<SendMessageResponse> {
		return await this.post(`/api/sessions/${sessionId}/messages`, {
			content,
			// `null` is meaningful (clear the thread override); only `undefined`
			// leaves the stored selection untouched.
			...(model !== undefined ? { model } : {}),
		} satisfies SendMessageRequest);
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

	private async put(path: string, body: unknown): Promise<any> {
		const response = await this.doFetch(`${this.baseUrl}${path}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!response.ok) throw await this.toError(response);
		return await response.json();
	}

	private async delete(path: string): Promise<any> {
		const response = await this.doFetch(`${this.baseUrl}${path}`, { method: "DELETE" });
		if (!response.ok) throw await this.toError(response);
		return await response.json();
	}

	private async toError(response: Response): Promise<RelayApiError> {
		const text = await response.text().catch(() => "");
		let message = text || response.statusText;
		try {
			const parsed = JSON.parse(text) as ErrorResponse;
			if (typeof parsed.error === "string") message = parsed.error;
		} catch {
			/* not JSON — use raw text */
		}
		return new RelayApiError(response.status, message);
	}
}
