import { join } from "node:path";

const AGENT_DIR = ".relay";

export function homeDir(): string | undefined {
	return process.env.HOME ?? process.env.USERPROFILE;
}

export function relayDir(): string {
	return join(homeDir() ?? ".", AGENT_DIR);
}
