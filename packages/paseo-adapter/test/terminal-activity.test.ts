import { describe, expect, it } from "vitest";
import { Script, createContext } from "node:vm";
import { terminalActivityUiScript } from "@pi-student/paseo-adapter/terminal-activity-ui";

function fakeTerminal(lines: string[]) {
	let osc: ((data: string) => boolean) | undefined;
	let title: ((value: string) => void) | undefined;
	return {
		parser: { registerOscHandler: (code: number, handler: (data: string) => boolean) => { expect(code).toBe(633); osc = handler; return { dispose() {} }; } },
		onTitleChange: (listener: (value: string) => void) => { title = listener; },
		registerMarker: () => ({ line: 0, isDisposed: false, dispose() {} }),
		buffer: { active: { baseY: 0, cursorY: lines.length - 1, getLine: (index: number) => ({ translateToString: () => lines[index] ?? "" }) } },
		osc: (data: string) => osc!(data),
		title: (value: string) => title!(value),
	};
}

function load(pathname: string) {
	const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
	const ticks: Array<() => void> = [];
	const window: Record<string, unknown> = {};
	const context = createContext({
		window, location: { pathname },
		fetch: async (url: string, init: { body: string }) => { requests.push({ url, body: JSON.parse(init.body) }); return {}; },
		setInterval: (callback: () => void) => { ticks.push(callback); return 1; },
	});
	new Script(terminalActivityUiScript(6769).replace(/^\s*<script[^>]*>/, "").replace(/<\/script>\s*$/, "")).runInContext(context);
	return { window, requests, tick: () => ticks.forEach(callback => callback()) };
}

describe("student terminal activity", () => {
	it("reports the command and exit code, and error output only for failures", async () => {
		const page = load("/h/local/workspace/wks_student-1");
		const terminal = fakeTerminal(["$ npm test", "FAIL src/reconnect.test.ts > reconnects", "AssertionError: expected 1 to be 2"]);
		page.window.__paseoTerminal = terminal;
		page.tick();
		page.tick();
		for (const [command, code] of [["npm run dev", "0"], ["npm test", "1"]] as const) {
			expect(terminal.osc("B")).toBe(false);
			terminal.osc("C");
			terminal.title(command);
			terminal.osc(`D;${code}`);
		}
		// A title change outside a command (the prompt's directory) is not a command.
		terminal.title("~/project");
		terminal.osc("D;0");
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(page.requests.map(request => request.url)).toEqual(Array(2).fill("http://127.0.0.1:6769/workspace-events?workspaceId=wks_student-1"));
		expect(page.requests[0]!.body).toEqual({ type: "terminal.command_finished", command: "npm run dev", exitCode: 0 });
		expect(page.requests[1]!.body).toMatchObject({ type: "terminal.command_finished", command: "npm test", exitCode: 1 });
		expect(page.requests[1]!.body.summary).toContain("AssertionError: expected 1 to be 2");
	});

	it("reports nothing outside a workspace", async () => {
		const page = load("/settings");
		const terminal = fakeTerminal([]);
		page.window.__paseoTerminal = terminal;
		page.tick();
		terminal.osc("C"); terminal.title("ls"); terminal.osc("D;0");
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(page.requests).toEqual([]);
	});
});
