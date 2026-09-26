import path from "node:path";
import type { Reporter } from "vitest/reporters";

type ErrorLike = { name?: string; message?: string; stack?: string; code?: string } | undefined;
type TaskLike = { name: string; tasks?: TaskLike[]; filepath?: string; result?: { state?: string; errors?: ErrorLike[] } };

const root = process.cwd();
const frames = (error: ErrorLike) => (error?.stack ?? "").split("\n").filter(line => line.trim().startsWith("at "));
/** Vitest's github-actions reporter only annotates errors with a frame in a project file outside node_modules. */
const annotatedByVitest = (error: ErrorLike) => frames(error).some(line => line.includes(root) && !line.includes(`${path.sep}node_modules${path.sep}`));
const escape = (value: string) => value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (value: string) => escape(value).replace(/:/g, "%3A").replace(/,/g, "%2C");

function describe(error: ErrorLike): string {
	const heading = `${error?.name ?? "Error"}${error?.code ? ` (${error.code})` : ""}: ${error?.message ?? String(error)}`;
	return [heading, ...frames(error).slice(0, 8)].join("\n");
}

/** Failed tasks of a file (the file itself for load and hook errors), titled like Vitest's "suite > test" names. */
function* failures(task: TaskLike, names: string[] = []): Generator<{ title: string; errors: ErrorLike[] }> {
	const title = task.filepath ? [] : [...names, task.name];
	if (task.result?.state === "fail" && task.result.errors?.length) yield { title: title.join(" > ") || "test file", errors: task.result.errors };
	for (const child of task.tasks ?? []) yield* failures(child, title);
}

/**
 * Vitest's github-actions reporter annotates only errors with a stack frame in a
 * project file. Unhandled rejections from `fs`, `child_process` or sockets, hook
 * timeouts, file load errors and assertions thrown inside dependencies carry no
 * such frame, so a run can fail with nothing but a generic "exited (1)" in the
 * check annotations. Annotate those too, so CI failures stay visible without
 * access to the job log.
 */
export default class UnhandledErrorAnnotations implements Reporter {
	onFinished(files: unknown[] = [], errors: unknown[] = []): void {
		for (const error of errors) process.stdout.write(`::error title=Vitest unhandled error::${escape(describe(error as ErrorLike))}\n`);
		for (const file of files as TaskLike[]) {
			const relative = file.filepath ? path.relative(root, file.filepath) : undefined;
			for (const failure of failures(file)) {
				for (const error of failure.errors.filter(error => !annotatedByVitest(error))) {
					const title = escapeProperty(`Vitest failure: ${failure.title}`);
					process.stdout.write(`::error ${relative ? `file=${escapeProperty(relative)},` : ""}title=${title}::${escape(describe(error))}\n`);
				}
			}
		}
	}
}
