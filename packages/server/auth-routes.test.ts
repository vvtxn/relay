import { assertEquals } from "@std/assert";
import { isGithubAllowed, safeReturnTo } from "./auth-routes.ts";

Deno.test("safeReturnTo - allows same-origin relative paths", () => {
	assertEquals(safeReturnTo("/s/abc"), "/s/abc");
	assertEquals(safeReturnTo("/s/abc?x=1"), "/s/abc?x=1");
	assertEquals(safeReturnTo("/"), "/");
});

Deno.test("safeReturnTo - rejects open-redirect attempts", () => {
	assertEquals(safeReturnTo(undefined), "/");
	assertEquals(safeReturnTo(""), "/");
	assertEquals(safeReturnTo("https://evil.com"), "/");
	assertEquals(safeReturnTo("//evil.com"), "/");
	assertEquals(safeReturnTo("/\\evil.com"), "/");
	assertEquals(safeReturnTo("/\t/evil.com"), "/");
	assertEquals(safeReturnTo("/path\u0000"), "/");
	assertEquals(safeReturnTo(`/${"a".repeat(3000)}`), "/");
});

Deno.test("isGithubAllowed - empty allowlist allows anyone", () => {
	assertEquals(isGithubAllowed([], { id: 1, login: "octocat" }), true);
});

Deno.test("isGithubAllowed - matches by login (case-insensitive) or id", () => {
	assertEquals(isGithubAllowed(["octocat"], { id: 1, login: "Octocat" }), true);
	assertEquals(isGithubAllowed(["12345"], { id: 12345, login: "octocat" }), true);
	assertEquals(isGithubAllowed(["someoneelse"], { id: 1, login: "octocat" }), false);
	assertEquals(isGithubAllowed(["octocat"], {}), false);
});
