import { describe, expect, it } from "vitest";
import { DISABLED_STUDENT_SLASH_COMMANDS, isDisabledStudentSlashCommand } from "../src/terminal/slash-commands.js";

describe("student slash command policy", () => {
	it("recognizes the removed commands with or without arguments", () => {
		for (const command of DISABLED_STUDENT_SLASH_COMMANDS) {
			expect(isDisabledStudentSlashCommand(`/${command}`)).toBe(true);
			expect(isDisabledStudentSlashCommand(`/${command} extra`)).toBe(true);
		}
	});

	it("keeps the singular theme command", () => {
		expect(isDisabledStudentSlashCommand("/theme")).toBe(false);
		expect(isDisabledStudentSlashCommand("/themes")).toBe(true);
		expect(isDisabledStudentSlashCommand("/help")).toBe(false);
		expect(isDisabledStudentSlashCommand("/question hard")).toBe(false);
	});
});
