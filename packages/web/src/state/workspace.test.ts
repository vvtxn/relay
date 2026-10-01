import { assertEquals } from "@std/assert";
import { resolveWorkspaceInput, setHomeDir } from "./workspace.ts";

Deno.test("resolveWorkspaceInput - expands ~ when the home dir is known", () => {
	setHomeDir("/home/magni");
	assertEquals(resolveWorkspaceInput("~/projects/relay"), "/home/magni/projects/relay");
	assertEquals(resolveWorkspaceInput("~"), "/home/magni");
});

Deno.test("resolveWorkspaceInput - rejects a tilde it cannot expand", () => {
	setHomeDir("");
	assertEquals(resolveWorkspaceInput("~/projects"), null);
});

Deno.test("resolveWorkspaceInput - passes absolute paths through", () => {
	setHomeDir("/home/magni");
	assertEquals(resolveWorkspaceInput("/opt/project"), "/opt/project");
	assertEquals(resolveWorkspaceInput("   "), null);
});
