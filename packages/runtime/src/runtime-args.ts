import { SessionManager } from "@earendil-works/pi-coding-agent";

export interface StudentRuntimeArgs {
	mode: "rpc";
	model?: string;
	thinking?: string;
	session?: string;
	noSession: boolean;
}

export function parseStudentRuntimeArgs(args: string[]): StudentRuntimeArgs {
	const parsed: StudentRuntimeArgs = { mode: "rpc", noSession: false };
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index] ?? "";
		const [name, inlineValue] = splitArgument(argument);
		if (name === "--no-session") {
			parsed.noSession = true;
			continue;
		}
		if (["--extension", "--mcp-config", "--name", "--provider"].includes(name)) {
			if (inlineValue === undefined) index = requireFollowingValue(args, index, name);
			continue;
		}
		if (["--mode", "--model", "--thinking", "--session"].includes(name)) {
			const value = inlineValue ?? args[requireFollowingValue(args, index, name)];
			if (inlineValue === undefined) index += 1;
			if (name === "--mode" && value !== "rpc") throw new Error("Pi Student runtime only supports --mode rpc.");
			if (name === "--model") parsed.model = value;
			if (name === "--thinking") parsed.thinking = value;
			if (name === "--session") parsed.session = value;
			continue;
		}
		throw new Error(`Unsupported Pi Student runtime option: ${argument}`);
	}
	if (parsed.noSession && parsed.session) throw new Error("--session and --no-session cannot be used together.");
	return parsed;
}

export function createRuntimeSessionManager(cwd: string, args: StudentRuntimeArgs): SessionManager {
	if (args.noSession) return SessionManager.inMemory(cwd);
	if (args.session) return SessionManager.open(args.session);
	return SessionManager.create(cwd);
}

export function splitModelId(value: string): { provider: string; modelId: string } {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1) {
		throw new Error(`Invalid model '${value}'. Expected provider/model.`);
	}
	return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

function splitArgument(argument: string): [string, string | undefined] {
	const separator = argument.indexOf("=");
	return separator === -1 ? [argument, undefined] : [argument.slice(0, separator), argument.slice(separator + 1)];
}

function requireFollowingValue(args: string[], index: number, name: string): number {
	const next = index + 1;
	if (!args[next] || args[next]?.startsWith("--")) throw new Error(`${name} requires a value.`);
	return next;
}
