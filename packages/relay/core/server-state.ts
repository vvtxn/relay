/**
 * Background-server state paths.
 *
 * Local and cloud runs are separate products: their state files and logs must
 * not overwrite each other, so the flavor is part of the filename.
 */

import { join } from "node:path";
import { relayDir } from "./paths.ts";

function flavorSuffix(flavor: string | undefined): string {
	return flavor?.trim() === "local" ? "-local" : "-cloud";
}

/** `~/.relay/server-<flavor>.json`. */
export function serverStatePath(flavor: string | undefined = process.env.RELAY_FLAVOR): string {
	return join(relayDir(), `server${flavorSuffix(flavor)}.json`);
}

/** `~/.relay/logs/server-<flavor>.log`. */
export function serverLogPath(flavor: string | undefined = process.env.RELAY_FLAVOR): string {
	return join(relayDir(), "logs", `server${flavorSuffix(flavor)}.log`);
}
