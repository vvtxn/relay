import { VERSION } from "../packages/cli/version.ts";
import { loadEnvFiles, resolveMode } from "./run-env.ts";

const decoder = new TextDecoder();

async function getGitHash(): Promise<string> {
	try {
		const cmd = new Deno.Command("git", {
			args: ["rev-parse", "--short", "HEAD"],
			stdout: "piped",
			stderr: "null",
		});
		const { stdout } = await cmd.output();
		return decoder.decode(stdout).trim();
	} catch {
		return "unknown";
	}
}

async function run(args: string[]) {
	const [command, ...rest] = args;
	if (!command) throw new Error("No command provided");
	const cmd = new Deno.Command(command, { args: rest, stdout: "inherit", stderr: "inherit" });
	const { code } = await cmd.output();
	if (code !== 0) {
		console.error(`Command failed with exit code ${code}: ${args.join(" ")}`);
		Deno.exit(1);
	}
}

/**
 * Write the merged mode env to a temp file so `deno compile` embeds it
 * deterministically (multiple `--env-file` precedence is ambiguous).
 */
async function writeMergedEnvFile(): Promise<string | null> {
	const mode = resolveMode(Deno.env.get("RELAY_ENV"));
	const values = loadEnvFiles(mode);
	const entries = Object.entries(values);
	if (entries.length === 0) return null;

	const body = entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n";
	const path = await Deno.makeTempFile({ prefix: "relay-build-env-", suffix: ".env" });
	await Deno.writeTextFile(path, body);
	return path;
}

async function build() {
	const hash = await getGitHash();
	const fullVersion = `${VERSION}+${hash}`;
	const embedEnv = Deno.args.includes("--embed-env");
	const compileArgs = [
		"deno",
		"compile",
		"--unstable-raw-imports",
		"--allow-env",
		"--allow-read",
		"--allow-write",
		"--allow-run",
		"--allow-net",
		"--output",
		"dist/relay",
		"packages/cli/agent/index.ts",
	];

	let envFilePath: string | null = null;
	if (embedEnv) {
		envFilePath = await writeMergedEnvFile();
		if (envFilePath) {
			compileArgs.splice(2, 0, `--env-file=${envFilePath}`);
			console.warn("Warning: --embed-env embeds environment values (possibly secrets) into the binary.");
		} else {
			console.warn("Warning: --embed-env found no env files to embed.");
		}
	}

	console.log(`Building relay v${fullVersion}`);

	try {
		await run(compileArgs);
	} finally {
		if (envFilePath) await Deno.remove(envFilePath).catch(() => {});
	}

	const stat = await Deno.stat("dist/relay");
	const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
	console.log(`\n✓ Built dist/relay (${sizeMB} MB)`);
	console.log(`  Version: ${fullVersion}`);
}

build();
