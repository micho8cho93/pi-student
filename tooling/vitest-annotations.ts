import type { Reporter } from "vitest/reporters";

/**
 * Vitest's github-actions reporter annotates only errors with a stack frame in a
 * project file. Unhandled rejections from `fs`, `child_process` or sockets carry
 * no such frame, so a run can fail with nothing but a generic "exited (1)" in the
 * check annotations. Annotate every unhandled error so CI failures stay visible
 * without access to the job log.
 */
export default class UnhandledErrorAnnotations implements Reporter {
	onFinished(_files?: unknown, errors: unknown[] = []): void {
		for (const error of errors) {
			const value = error as { name?: string; message?: string; stack?: string; code?: string } | undefined;
			const heading = `${value?.name ?? "Error"}${value?.code ? ` (${value.code})` : ""}: ${value?.message ?? String(error)}`;
			const frames = (value?.stack ?? "").split("\n").filter(line => line.trim().startsWith("at ")).slice(0, 8);
			const message = [heading, ...frames].join("\n").replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
			process.stdout.write(`::error title=Vitest unhandled error::${message}\n`);
		}
	}
}
