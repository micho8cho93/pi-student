import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createTheme, renderPanel } from "../terminal/ui.js";
import { BUNDLED_THEME_NAMES, createBundledThemes } from "../terminal/themes.js";

describe("terminal themes", () => {
	it("ships the full dark, light, pastel, neon, and monochrome theme range", () => {
		const themes = createBundledThemes();
		expect(themes.map(({ name }) => name)).toEqual(BUNDLED_THEME_NAMES);
		expect(new Set(themes.map((theme) => theme.getFgAnsi("accent"))).size).toBe(themes.length);
	});

	it("keeps shell activity distinct from actual errors", () => {
		for (const theme of createBundledThemes()) {
			expect(theme.getFgAnsi("bashMode"), theme.name).not.toBe(theme.getFgAnsi("error"));
			expect(theme.bg("toolPendingBg", " "), theme.name).not.toBe(theme.bg("toolErrorBg", " "));
		}
	});

	it("renders aligned panels when color output is disabled", () => {
		const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
		const panel = renderPanel(createTheme(output), "Status", [
			{ label: "stage", value: "UNDERSTAND", tone: "accent" },
			{ label: "sandbox", value: "isolated workspace", tone: "success" },
		]);
		const widths = panel.split("\n").map((line) => Array.from(line).length);
		expect(new Set(widths).size).toBe(1);
		expect(panel).toContain("╭─ Status");
		expect(panel).toContain("╰");
	});
});
