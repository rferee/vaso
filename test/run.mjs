/**
 * Bundles every test/*.test.ts with esbuild into a temporary directory, with
 * "obsidian" replaced by test/obsidian-stub.ts, and runs the bundles with the
 * Node test runner.
 */

import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(dir).filter((f) => f.endsWith(".test.ts")).sort();
const out = mkdtempSync(path.join(tmpdir(), "vaso-test-"));

const obsidianStub = {
	name: "obsidian-stub",
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(dir, "obsidian-stub.ts") }));
	},
};

try {
	await esbuild.build({
		entryPoints: tests.map((f) => path.join(dir, f)),
		outdir: out,
		outExtension: { ".js": ".mjs" },
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node20",
		logLevel: "warning",
		// The plugin's timers go through `window`, as Obsidian expects.
		banner: { js: "globalThis.window ??= globalThis;" },
		plugins: [obsidianStub],
	});
	const files = tests.map((f) => path.join(out, f.replace(/\.ts$/, ".mjs")));
	const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
	process.exitCode = result.status ?? 1;
} finally {
	rmSync(out, { recursive: true, force: true });
}
