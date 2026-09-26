import { configDefaults, defineConfig } from "vitest/config";

// Every package runs `vitest run --root ../..`, so this applies to the whole monorepo.
export default defineConfig({
	test: {
		globalSetup: ["./tooling/vitest-hermetic.ts"],
		// Naming reporters replaces Vitest's defaults, so keep github-actions explicitly on CI.
		reporters: process.env.GITHUB_ACTIONS === "true" ? ["default", "github-actions", "./tooling/vitest-annotations.ts"] : ["default"],
		// CI's unit job runs every package's suite at once on a shared runner, so tests that spawn
		// processes or a browser can take several times longer than on an idle machine. Timeouts stay
		// finite so a hang still fails, but a slow machine alone does not.
		testTimeout: 20_000,
		hookTimeout: 30_000,
		// tooling/*.test.mjs are node:test suites run by `npm run test:architecture`.
		exclude: [...configDefaults.exclude, "tooling/**"],
	},
});
