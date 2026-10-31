import { Effect } from "effect";
import type { Tool, ToolResult } from "@vvtxn/relay/core/tools/types.ts";
import type { SandboxProvider } from "./sandbox.ts";

const SCRIPT_PATH = "/tmp/relay-browser-check.cjs";
const MAX_BODY = 5_000;

/**
 * Runs a one-shot Playwright check inside the current managed box.
 *
 * The generated session tool script lives in the guest `/tmp`; agents should
 * never add probe `.mjs` files to the repository. The script prefers the
 * project's Playwright install and falls back to the globally installed one
 * from the prepared image.
 */
const BROWSER_CHECK_SCRIPT = String.raw`
const path = require("node:path");

function loadPlaywright() {
  const candidates = [
    path.join(process.cwd(), "node_modules", "playwright"),
    "/usr/local/lib/node_modules/playwright",
    "playwright",
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Try the next location.
    }
  }
  throw new Error("Playwright is not installed in this box");
}

(async () => {
  const config = JSON.parse(Buffer.from(process.env.RELAY_BROWSER_CONFIG, "base64").toString("utf8"));
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push("pageerror: " + error.message));
  try {
    const response = await page.goto(config.url, {
      waitUntil: "domcontentloaded",
      timeout: config.timeoutMs,
    });
    if (config.waitFor) await page.waitForSelector(config.waitFor, { timeout: config.timeoutMs });
    if (config.waitMs) await page.waitForTimeout(config.waitMs);
    let evaluated;
    if (config.evaluate) {
      evaluated = await page.evaluate((source) => eval(source), config.evaluate);
    }
    let scriptResult;
    if (config.script) {
      scriptResult = await page.evaluate(
        async (source) => await eval("(async () => {" + source + "})()"),
        config.script,
      );
    }
    const body = (await page.locator("body").innerText()).slice(0, ${MAX_BODY});
    const result = {
      ok: true,
      status: response ? response.status() : null,
      url: page.url(),
      title: await page.title(),
      evaluated,
      scriptResult,
      consoleErrors,
      body,
    };
    console.log(JSON.stringify(result));
  } finally {
    await browser.close().catch(() => {});
  }
})().catch((error) => {
  console.log(JSON.stringify({ ok: false, error: String(error && error.stack ? error.stack : error) }));
  process.exit(1);
});
`;

interface BrowserInput {
	action?: unknown;
	url?: unknown;
	waitFor?: unknown;
	waitMs?: unknown;
	timeoutMs?: unknown;
	evaluate?: unknown;
	script?: unknown;
}

type BrowserResult =
	| {
			ok: true;
			status: number | null;
			url: string;
			title: string;
			evaluated?: unknown;
			scriptResult?: unknown;
			consoleErrors: string[];
			body: string;
	  }
	| { ok: false; error: string };

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown, fallback: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.min(Math.floor(value), max);
}

export function createBrowserTool(provider: SandboxProvider): Tool {
	return {
		definition: {
			type: "function",
			function: {
				name: "browser",
				description:
					"Run a one-shot Playwright check inside the current managed box. Navigate a URL, optionally wait for a selector, evaluate a DOM expression, or run an inline async script. Use this for rendered UI verification; do not create probe .mjs files or install browsers.",
				parameters: {
					type: "object",
					properties: {
						action: {
							type: "string",
							enum: ["check"],
							description: "The browser check to run.",
						},
						url: {
							type: "string",
							description: "Absolute http(s) URL to open.",
						},
						waitFor: {
							type: "string",
							description: "Optional CSS selector to wait for before evaluating.",
						},
						waitMs: {
							type: "number",
							description: "Extra settle time after navigation in milliseconds (default 500).",
						},
						timeoutMs: {
							type: "number",
							description: "Navigation/selector timeout in milliseconds (default 30000).",
						},
						evaluate: {
							type: "string",
							description: "Optional JavaScript expression evaluated in the page after navigation.",
						},
						script: {
							type: "string",
							description:
								"Optional async JavaScript body evaluated in the page, e.g. `return document.title;`; return a JSON-serializable value.",
						},
					},
					required: ["action", "url"],
					additionalProperties: false,
				},
			},
		},
		usageHint:
			"Use browser for rendered UI checks inside the sandbox. It runs Playwright against a URL and returns title, DOM text, console errors, and any evaluated result. Never create .mjs probe scripts or install browsers.",
		execute: (input): Effect.Effect<ToolResult> =>
			Effect.gen(function* () {
				const value = (input ?? {}) as BrowserInput;
				if (value.action !== undefined && value.action !== "check") {
					return { content: 'The browser tool only supports action "check".', isError: true };
				}
				const rawUrl = optionalString(value.url);
				if (!rawUrl) return { content: "A URL is required.", isError: true };
				let parsed: URL;
				try {
					parsed = new URL(rawUrl);
				} catch {
					return { content: `Invalid URL: ${rawUrl}`, isError: true };
				}
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
					return { content: "The browser tool only accepts http or https URLs.", isError: true };
				}
				const config = {
					url: parsed.toString(),
					waitFor: optionalString(value.waitFor),
					waitMs: optionalNumber(value.waitMs, 500, 60_000),
					timeoutMs: optionalNumber(value.timeoutMs, 30_000, 300_000),
					evaluate: optionalString(value.evaluate),
					script: optionalString(value.script),
				};
				const configBase64 = Buffer.from(JSON.stringify(config)).toString("base64");
				const scriptBase64 = Buffer.from(BROWSER_CHECK_SCRIPT).toString("base64");
				const command =
					`printf '%s' '${scriptBase64}' | base64 -d > ${SCRIPT_PATH} && ` +
					`RELAY_BROWSER_CONFIG='${configBase64}' PLAYWRIGHT_BROWSERS_PATH=/opt/playwright ` +
					`node ${SCRIPT_PATH}`;
				const result = yield* provider
					.withLease((lease) => lease.exec(command, { timeoutMs: 180_000 }))
					.pipe(
						Effect.catchTag("BoxError", (error) =>
							Effect.succeed({
								code: 1,
								stdout: "",
								stderr: error.message,
								durationMs: 0,
								truncated: false,
							}),
						),
					);
				const line = result.stdout.trim().split("\n").at(-1) ?? "";
				let parsedResult: BrowserResult | null = null;
				try {
					parsedResult = JSON.parse(line) as BrowserResult;
				} catch {
					parsedResult = null;
				}
				if (!parsedResult) {
					return {
						content:
							`Browser check failed (exit ${result.code}).\n${result.stderr || result.stdout}`.trim(),
						isError: true,
					};
				}
				if (!parsedResult.ok) {
					return { content: `Browser check failed: ${parsedResult.error}`, isError: true };
				}
				const lines = [
					`Status: ${parsedResult.status ?? "(no response)"}`,
					`URL: ${parsedResult.url}`,
					`Title: ${parsedResult.title}`,
				];
				if (parsedResult.evaluated !== undefined) {
					lines.push(`Evaluated: ${JSON.stringify(parsedResult.evaluated)}`);
				}
				if (parsedResult.scriptResult !== undefined) {
					lines.push(`Script result: ${JSON.stringify(parsedResult.scriptResult)}`);
				}
				if (parsedResult.consoleErrors.length > 0) {
					lines.push(`Console errors:\n${parsedResult.consoleErrors.join("\n")}`);
				}
				if (parsedResult.body) lines.push(`Body:\n${parsedResult.body}`);
				return { content: lines.join("\n\n") };
			}),
	};
}
