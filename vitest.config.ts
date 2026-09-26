import { configDefaults, defineConfig } from "vitest/config";

// Every package runs `vitest run --root ../..`, so this applies to the whole monorepo.
export default defineConfig({
	test: {
		globalSetup: ["./tooling/vitest-hermetic.ts"],
		// tooling/*.test.mjs are node:test suites run by `npm run test:architecture`.
		exclude: [...configDefaults.exclude, "tooling/**"],
	},
});
