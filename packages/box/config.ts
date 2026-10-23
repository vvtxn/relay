import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BoxError } from "./errors.ts";
import { isBoxProfile, profileRank, profileResources } from "./profiles.ts";
import type { BoxProfile, BoxSettings, ProjectBoxConfig } from "./types.ts";

const PROJECT_CONFIG_PATH = join(".relay", "box.json");

function positiveInteger(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new BoxError({ message: `.relay/box.json: ${field} must be a positive integer` });
	}
	return value;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new BoxError({ message: `.relay/box.json: ${field} must be a non-empty string` });
	}
	return value;
}

function optionalProfile(value: unknown, field: string): BoxProfile | undefined {
	if (value === undefined) return undefined;
	if (!isBoxProfile(value)) {
		throw new BoxError({ message: `.relay/box.json: ${field} must be "tiny", "small", or "medium"` });
	}
	return value;
}

function stringMap(value: unknown, field: string): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new BoxError({ message: `.relay/box.json: ${field} must be an object of strings` });
	}
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string") {
			throw new BoxError({ message: `.relay/box.json: ${field}.${key} must be a string` });
		}
		result[key] = entry;
	}
	return result;
}

function stringList(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new BoxError({ message: `.relay/box.json: ${field} must be an array of strings` });
	}
	return value as string[];
}

export function parseProjectConfig(raw: unknown): ProjectBoxConfig {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new BoxError({ message: ".relay/box.json must contain an object" });
	}
	const value = raw as Record<string, unknown>;
	if (value.version !== undefined && value.version !== 1) {
		throw new BoxError({ message: `Unsupported .relay/box.json version: ${JSON.stringify(value.version)}` });
	}
	const known = new Set([
		"version",
		"image",
		"profile",
		"maxProfile",
		"cpus",
		"memoryMiB",
		"rootDiskMiB",
		"setup",
		"resume",
		"env",
		"exclude",
	]);
	for (const key of Object.keys(value)) {
		if (!known.has(key)) throw new BoxError({ message: `Unknown .relay/box.json field: ${key}` });
	}

	const config: ProjectBoxConfig = { version: 1 };
	const image = optionalString(value.image, "image");
	const profile = optionalProfile(value.profile, "profile");
	const maxProfile = optionalProfile(value.maxProfile, "maxProfile");
	const cpus = positiveInteger(value.cpus, "cpus");
	const memoryMiB = positiveInteger(value.memoryMiB, "memoryMiB");
	const rootDiskMiB = positiveInteger(value.rootDiskMiB, "rootDiskMiB");
	const setup = optionalString(value.setup, "setup");
	const resume = optionalString(value.resume, "resume");
	const env = stringMap(value.env, "env");
	const exclude = stringList(value.exclude, "exclude");
	if (image !== undefined) config.image = image;
	if (profile !== undefined) config.profile = profile;
	if (maxProfile !== undefined) config.maxProfile = maxProfile;
	if (cpus !== undefined) config.cpus = cpus;
	if (memoryMiB !== undefined) config.memoryMiB = memoryMiB;
	if (rootDiskMiB !== undefined) config.rootDiskMiB = rootDiskMiB;
	if (setup !== undefined) config.setup = setup;
	if (resume !== undefined) config.resume = resume;
	if (env !== undefined) config.env = env;
	if (exclude !== undefined) config.exclude = exclude;
	return config;
}

/** Read `.relay/box.json`; absent is not an error. */
export async function readProjectConfig(projectCwd: string): Promise<ProjectBoxConfig | null> {
	const path = join(projectCwd, PROJECT_CONFIG_PATH);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw new BoxError({ message: `Could not read ${path}`, cause: error });
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text) as unknown;
	} catch (error) {
		throw new BoxError({ message: `Could not parse ${path}`, cause: error });
	}
	return parseProjectConfig(raw);
}

/** Project config overrides server defaults field by field. */
export function resolveBoxSettings(defaults: BoxSettings, project: ProjectBoxConfig | null): BoxSettings {
	if (!project) return defaults;
	const maxProfile = project.maxProfile ?? defaults.maxProfile;
	const requestedProfile = project.profile ?? defaults.profile;
	// A project can lower the ceiling but never raise it past the server default.
	const profile = profileRank(requestedProfile) > profileRank(maxProfile) ? maxProfile : requestedProfile;
	const resources = profileResources(profile);
	const cpus = project.cpus ?? (project.profile ? resources.cpus : defaults.cpus);
	const memoryMiB = project.memoryMiB ?? (project.profile ? resources.memoryMiB : defaults.memoryMiB);
	const rootDiskMiB = project.rootDiskMiB ?? (project.profile ? resources.rootDiskMiB : defaults.rootDiskMiB);
	return {
		image: project.image ?? defaults.image,
		profile,
		maxProfile,
		cpus,
		memoryMiB,
		rootDiskMiB,
		...(project.setup !== undefined
			? { setup: project.setup }
			: defaults.setup !== undefined
				? { setup: defaults.setup }
				: {}),
		...(project.resume !== undefined
			? { resume: project.resume }
			: defaults.resume !== undefined
				? { resume: defaults.resume }
				: {}),
		env: { ...defaults.env, ...project.env },
		exclude: project.exclude ?? defaults.exclude,
	};
}

/** Resolve project configuration for a box creation path. */
export async function resolveProjectBoxSettings(projectCwd: string, defaults: BoxSettings): Promise<BoxSettings> {
	return resolveBoxSettings(defaults, await readProjectConfig(projectCwd));
}
