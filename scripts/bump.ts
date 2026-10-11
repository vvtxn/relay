import { readFileSync, writeFileSync } from "node:fs";
import { VERSION } from "../packages/relay/version.ts";

const part = process.argv[2] as "patch" | "minor" | "major" | undefined;

if (!part || !["patch", "minor", "major"].includes(part)) {
	console.error("Usage: pnpm version:bump <patch|minor|major>");
	process.exit(1);
}

const [major = 0, minor = 0, patch = 0] = VERSION.split(".").map(Number);

let next: string;
switch (part) {
	case "major":
		next = `${major + 1}.0.0`;
		break;
	case "minor":
		next = `${major}.${minor + 1}.0`;
		break;
	case "patch":
		next = `${major}.${minor}.${patch + 1}`;
		break;
}

// Update the canonical version file (clients re-export it)
const content = `/**
 * Relay version — the single source for every client and the server.
 *
 * Lives in \`@vvtxn/relay\` (the leaf package) so the CLI, web app, and server
 * can all import it without a dependency cycle. \`scripts/bump.ts\` writes here.
 */
export const VERSION = "${next}";
`;
writeFileSync("packages/relay/version.ts", content);

// Update README.md
const readme = readFileSync("README.md", "utf8");
const updatedReadme = readme.replace(/Relay v\d+\.\d+\.\d+/, `Relay v${next}`);
writeFileSync("README.md", updatedReadme);

console.log(`${VERSION} → ${next}`);
