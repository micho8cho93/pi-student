#!/usr/bin/env node

import process from "node:process";
import { runTeacherCommand } from "./commands.js";

try {
	await runTeacherCommand(["teacher", ...process.argv.slice(2)]);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
