import { defineConfig } from "vite-plus";

/**
 * Workspace-wide tooling for the Relay monorepo.
 *
 * - `vp check` formats (Oxfmt), lints (Oxlint, type-aware), and type-checks with `tsgo`.
 * - Formatting mirrors the previous `deno fmt` config: tabs, 120 columns,
 *   double quotes, semicolons.
 */
export default defineConfig({
	// Vitest runs through the Vite+ toolchain; suites live in packages/*/test.
	test: {
		include: ["packages/*/test/**/*.test.ts"],
		environment: "node",
	},
	fmt: {
		useTabs: true,
		tabWidth: 4,
		printWidth: 120,
		semi: true,
		singleQuote: false,
		ignorePatterns: ["dist/**", "**/dist/**", "node_modules/**", "pnpm-lock.yaml", "*.md"],
	},
	lint: {
		ignorePatterns: ["dist/**", "**/dist/**", "node_modules/**"],
		options: {
			typeAware: true,
			typeCheck: true,
		},
		plugins: ["typescript", "import"],
		rules: {
			// Matches the previous deno lint configuration.
			"typescript/no-explicit-any": "off",
		},
		overrides: [
			{
				// JSX in the web app is Solid, not React: only keep the house rule
				// the old deno lint enforced, and silence compiler-style rules that
				// assume React's rendering model.
				files: ["packages/web/**/*.tsx"],
				plugins: ["react"],
				rules: {
					"react/button-has-type": "error",
					"react/refs": "off",
					"react/purity": "off",
					"react/immutability": "off",
					// Solid iterates with <For> and `.map()` without React keys.
					"react/jsx-key": "off",
					// Solid refs are assigned through the `ref` JSX prop.
					"eslint/no-unassigned-vars": "off",
				},
			},
		],
	},
});
