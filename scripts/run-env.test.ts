import { assertEquals } from "@std/assert";
import { envFileCandidates, resolveEnv, resolveMode } from "./run-env.ts";

function reader(files: Record<string, Record<string, string>>) {
	return (path: string): Record<string, string> | null => files[path] ?? null;
}

Deno.test("resolveMode - defaults to development and accepts production", () => {
	assertEquals(resolveMode(undefined), "development");
	assertEquals(resolveMode("development"), "development");
	assertEquals(resolveMode("production"), "production");
	assertEquals(resolveMode("staging"), "development");
});

Deno.test("envFileCandidates - most specific first", () => {
	assertEquals(envFileCandidates("development"), [
		".env.development.local",
		".env.development",
		".env.local",
		".env",
	]);
});

Deno.test("resolveEnv - more specific files override less specific ones", () => {
	const merged = resolveEnv(
		"development",
		reader({
			".env": { RELAY_PUBLIC_URL: "http://base", SHARED: "base" },
			".env.local": { SHARED: "local" },
			".env.development": { RELAY_PUBLIC_URL: "http://dev" },
			".env.development.local": { SHARED: "dev-local" },
		}),
		{},
	);
	assertEquals(merged.RELAY_PUBLIC_URL, "http://dev");
	assertEquals(merged.SHARED, "dev-local");
});

Deno.test("resolveEnv - production files do not leak into development", () => {
	const merged = resolveEnv(
		"development",
		reader({
			".env.production": { RELAY_STATIC_DIR: "packages/web/dist" },
			".env.development": { RELAY_PUBLIC_URL: "http://localhost:5173" },
		}),
		{},
	);
	assertEquals(merged.RELAY_STATIC_DIR, undefined);
	assertEquals(merged.RELAY_PUBLIC_URL, "http://localhost:5173");
});

Deno.test("resolveEnv - the process environment wins", () => {
	const merged = resolveEnv(
		"production",
		reader({ ".env.production": { RELAY_PUBLIC_URL: "http://from-file" } }),
		{ RELAY_PUBLIC_URL: "http://from-process" },
	);
	assertEquals(merged.RELAY_PUBLIC_URL, "http://from-process");
});

Deno.test("resolveEnv - missing files are skipped", () => {
	const merged = resolveEnv("development", reader({}), {});
	assertEquals(merged, {});
});
