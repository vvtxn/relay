import { defineConfig } from "vite-plus";
import solid from "vite-plugin-solid";
import path from "node:path";

const here = import.meta.dirname ?? ".";

export default defineConfig({
	plugins: [solid()],
	resolve: {
		// `#/` resolves through the package.json `imports` field.
		alias: [
			{ find: /^@vvtxn\/relay\//, replacement: path.resolve(here, "../relay") + "/" },
			{ find: /^@vvtxn\/client\//, replacement: path.resolve(here, "../client") + "/" },
		],
	},
	build: {
		target: "esnext",
		outDir: "dist",
		emptyOutDir: true,
	},
});
