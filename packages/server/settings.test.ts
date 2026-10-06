import { assertEquals, assertRejects } from "@std/assert";
import type { SettingsResponse } from "@vvtxn/client/protocol.ts";
import { BadRequestError } from "./http.ts";
import { handleGetSettings, handleSetApiKey } from "./settings.ts";
import type { RequestServices } from "./services.ts";

function services(store: { key: string | null }): RequestServices {
	return {
		user: { id: "user-1" },
		userSettings: {
			getApiKey: (_userId: string) => Promise.resolve(store.key),
			setApiKey: (_userId: string, apiKey: string | null) => {
				store.key = apiKey;
				return Promise.resolve();
			},
		},
	} as unknown as RequestServices;
}

function jsonRequest(body: unknown): Request {
	return new Request("http://localhost/api/settings/api-key", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function settings(response: Response): Promise<SettingsResponse> {
	return await response.json() as SettingsResponse;
}

Deno.test("handleGetSettings - reports an unset key without exposing anything", async () => {
	const response = await handleGetSettings(services({ key: null }));
	assertEquals(await settings(response), { apiKey: { set: false, hint: null } });
});

Deno.test("handleGetSettings - returns only a masked hint, never the key", async () => {
	const response = await handleGetSettings(services({ key: "sk-very-secret-1234" }));
	const body = await settings(response);
	assertEquals(body.apiKey.set, true);
	assertEquals(body.apiKey.hint, "1234");
	assertEquals(JSON.stringify(body).includes("secret"), false);
});

Deno.test("handleSetApiKey - stores a trimmed key", async () => {
	const store = { key: null as string | null };
	const response = await handleSetApiKey(services(store), jsonRequest({ apiKey: "  sk-test  " }));
	assertEquals(response.status, 200);
	assertEquals(store.key, "sk-test");
});

Deno.test("handleSetApiKey - clears the key on null or empty", async () => {
	const store = { key: "sk-old" };
	await handleSetApiKey(services(store), jsonRequest({ apiKey: null }));
	assertEquals(store.key, null);

	store.key = "sk-old";
	await handleSetApiKey(services(store), jsonRequest({ apiKey: "   " }));
	assertEquals(store.key, null);
});

Deno.test("handleSetApiKey - rejects a non-string key", async () => {
	await assertRejects(
		() => handleSetApiKey(services({ key: null }), jsonRequest({ apiKey: 42 })),
		BadRequestError,
		"apiKey must be a string or null",
	);
});

Deno.test("handleSetApiKey - rejects an overlong key", async () => {
	await assertRejects(
		() => handleSetApiKey(services({ key: null }), jsonRequest({ apiKey: "x".repeat(513) })),
		BadRequestError,
		"at most 512",
	);
});
