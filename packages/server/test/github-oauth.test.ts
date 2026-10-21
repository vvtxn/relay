// GitHub's token endpoint expects form-encoded parameters, not a JSON body.

import { afterEach, describe, expect, it } from "vite-plus/test";
import { exchangeCode } from "../github-oauth.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("exchangeCode", () => {
	it("posts form-encoded credentials and reads the JSON token", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			calls.push({ url, ...(init ? { init } : {}) });
			return new Response(JSON.stringify({ access_token: "ghu_test" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;

		const token = await exchangeCode({
			clientId: "client-id",
			clientSecret: "client-secret",
			code: "code",
			redirectUri: "http://127.0.0.1:7433/api/auth/callback",
			verifier: "verifier",
		});

		expect(token).toBe("ghu_test");
		const request = calls[0];
		if (!request) throw new Error("fetch was not called");
		expect(request.url).toBe("https://github.com/login/oauth/access_token");
		expect(request.init?.method).toBe("POST");
		const headers = request.init?.headers as Record<string, string>;
		expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
		const body = new URLSearchParams(typeof request.init?.body === "string" ? request.init.body : "");
		expect(body.get("client_id")).toBe("client-id");
		expect(body.get("client_secret")).toBe("client-secret");
		expect(body.get("code")).toBe("code");
		expect(body.get("code_verifier")).toBe("verifier");
		expect(body.get("redirect_uri")).toBe("http://127.0.0.1:7433/api/auth/callback");
	});
});
