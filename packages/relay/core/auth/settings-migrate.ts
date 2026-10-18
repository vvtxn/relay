/**
 * One-shot migration from the database backend to the file backend: moves
 * every stored API key to the local encrypted file store and clears the
 * database columns, so the cloud table ends up without secrets.
 *
 * Best effort per user — a row that cannot be moved (for example ciphertext
 * written under a different master key) is left untouched rather than purged,
 * and a partially failed run is safe to repeat: rows are cleared only after
 * their file has been written.
 */

import { Effect } from "effect";
import type { StoreError } from "../effect.ts";
import type { DatabaseUserSettingsStore } from "./settings.ts";
import type { FileUserSettingsStore } from "./settings-file.ts";

export interface ApiKeyMigrationResult {
	/** Keys copied to the file store and purged from the database. */
	migrated: number;
	/** Rows that could not be moved; they remain in the database. */
	failed: number;
}

export function migrateApiKeysToFile(
	from: DatabaseUserSettingsStore,
	to: FileUserSettingsStore,
): Effect.Effect<ApiKeyMigrationResult, StoreError> {
	return Effect.gen(function* () {
		const userIds = yield* from.listUserIdsWithKeys();
		let migrated = 0;
		let failed = 0;
		for (const userId of userIds) {
			const outcome = yield* Effect.gen(function* () {
				const apiKey = yield* from.getApiKey(userId);
				if (!apiKey) return "skipped" as const;
				yield* to.setApiKey(userId, apiKey);
				yield* from.setApiKey(userId, null);
				return "migrated" as const;
			}).pipe(Effect.catchTag("StoreError", () => Effect.succeed("failed" as const)));
			if (outcome === "migrated") migrated++;
			if (outcome === "failed") failed++;
		}
		return { migrated, failed };
	});
}
