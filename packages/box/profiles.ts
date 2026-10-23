import type { BoxProfile, BoxSettings } from "./types.ts";

export interface BoxProfileResources {
	cpus: number;
	memoryMiB: number;
	rootDiskMiB: number;
}

/**
 * Named resource bundles.
 *
 * `tiny` is the default: enough for editing, grep, and lightweight commands.
 * `small` is the practical minimum for Playwright/browser work and normal
 * builds. `medium` covers monorepo builds and several services.
 */
export const BOX_PROFILES: Record<BoxProfile, BoxProfileResources> = {
	tiny: { cpus: 1, memoryMiB: 2048, rootDiskMiB: 8192 },
	small: { cpus: 2, memoryMiB: 4096, rootDiskMiB: 16384 },
	medium: { cpus: 4, memoryMiB: 8192, rootDiskMiB: 32768 },
};

/** Stable ordering from smallest to largest. */
export const BOX_PROFILE_ORDER: readonly BoxProfile[] = ["tiny", "small", "medium"];

export function isBoxProfile(value: unknown): value is BoxProfile {
	return typeof value === "string" && value in BOX_PROFILES;
}

export function profileResources(profile: BoxProfile): BoxProfileResources {
	return BOX_PROFILES[profile];
}

/** Rank a profile so ceilings can be compared without string ordering. */
export function profileRank(profile: BoxProfile): number {
	return BOX_PROFILE_ORDER.indexOf(profile);
}

/** Smallest profile that contains the requested resources. */
export function profileForResources(resources: {
	cpus: number;
	memoryMiB: number;
	rootDiskMiB: number;
}): BoxProfile | "custom" {
	for (const profile of BOX_PROFILE_ORDER) {
		const candidate = BOX_PROFILES[profile];
		if (
			candidate.cpus >= resources.cpus &&
			candidate.memoryMiB >= resources.memoryMiB &&
			candidate.rootDiskMiB >= resources.rootDiskMiB
		) {
			return profile;
		}
	}
	return "custom";
}

export function profileForSettings(settings: Pick<BoxSettings, "cpus" | "memoryMiB">): BoxProfile | "custom" {
	for (const profile of BOX_PROFILE_ORDER) {
		const candidate = BOX_PROFILES[profile];
		if (candidate.cpus === settings.cpus && candidate.memoryMiB === settings.memoryMiB) return profile;
	}
	return "custom";
}
