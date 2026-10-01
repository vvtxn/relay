import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import path from "node:path";

const here = import.meta.dirname ?? ".";

export default defineConfig({
	plugins: [solid()],
	resolve: {
		alias: [
			{ find: /^@\//, replacement: path.resolve(here, "src") + "/" },
			{ find: /^@vvtxn\/relay\//, replacement: path.resolve(here, "../relay") + "/" },
			{ find: /^@vvtxn\/client\//, replacement: path.resolve(here, "../client") + "/" },
		],
	},
	server: {
		fs: {
			allow: [path.resolve(here, "..")],
		},
		proxy: {
			"/api": {
				target: "http://127.0.0.1:7433",
			},
		},
	},
	build: {
		target: "esnext",
		outDir: "dist",
		emptyOutDir: true,
	},
});
