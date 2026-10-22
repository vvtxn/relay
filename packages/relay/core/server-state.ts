/**
 * Background-server state paths.
 *
 * Local and cloud runs are separate products: their state files and logs must
 * not overwrite each other, so the flavor is part of the filename. The default
 * flavor is cloud, matching server config; pass `null` for the legacy names.
 */

import { join } from "node:path";
import { relayDir } from "./paths.ts";

function flavorSuffix(flavor: string | null | undefined): string {
	const value = flavor?.trim();
	return value === "local" || value === "cloud" ? `-${value}` : "";
}

/**
 * `~/.relay/server-<flavor>.json`, or `server.json` when `flavor` is `null`.
 * Pass `null` explicitly to request the legacy unflavored name.
 */
export function serverStatePath(flavor: string | null = process.env.RELAY_FLAVOR || "cloud"): string {
	return join(relayDir(), `server${flavorSuffix(flavor)}.json`);
}

/**
 * `~/.relay/logs/server-<flavor>.log`, or `server.log` when `flavor` is `null`.
 * Pass `null` explicitly to request the legacy unflavored name.
 */
export function serverLogPath(flavor: string | null = process.env.RELAY_FLAVOR || "cloud"): string {
	return join(relayDir(), "logs", `server${flavorSuffix(flavor)}.log`);
}
