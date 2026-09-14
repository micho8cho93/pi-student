import { describe, expect, it } from "vitest";
import { teacherTuiTestables } from "../teacher/tui.js";
import { readTeacherPort } from "../teacher/commands.js";

describe("teacher terminal dashboard", () => {
	it("uses the default companion site port and validates overrides", () => {
		expect(readTeacherPort([])).toBe(4173);
		expect(readTeacherPort(["--port", "5000"])).toBe(5000);
		expect(() => readTeacherPort(["--port", "nope"])).toThrow(/1 to 65535/);
	});

	it("accepts numbers and short section commands", () => {
		expect(teacherTuiTestables.tabCommand("1")).toBe("today");
		expect(teacherTuiTestables.tabCommand("s")).toBe("students");
		expect(teacherTuiTestables.tabCommand("projects")).toBe("projects");
		expect(teacherTuiTestables.rangeCommand("2")).toBe("week");
	});

	it("lists terminal-only dictation in teacher help", () => {
		expect(teacherTuiTestables.renderHelpText()).toContain("/dictate");
		expect(teacherTuiTestables.renderHelpText()).toContain("terminal only");
	});

	it("keeps quoted names together", () => {
		expect(teacherTuiTestables.splitCommand('new "AP CSP — Period 2"')).toEqual(["new", "AP CSP — Period 2"]);
	});

	it("wraps long student evidence without dropping text", () => {
		const text = "A student-authored reflection with enough detail to continue onto another terminal row.";
		const lines = teacherTuiTestables.wrapText(text, 24);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines.join(" ")).toBe(text);
	});

	it("groups the Today cards by student and preserves attention signals", () => {
		const groups = teacherTuiTestables.groupSessions([
			{ id: "one", student_id: "student-a", started_at: "2026-09-13T08:00:00Z", duration_seconds: 600, total_tokens: 120, files_created: 1, files_modified: 2, files_deleted: 0, models: ["model-a"], implementation_assistance: "high", blockers: ["API"], profiles: { display_name: "Ada" }, projects: { name: "Weather" } },
			{ id: "two", student_id: "student-a", started_at: "2026-09-13T09:00:00Z", duration_seconds: 300, total_tokens: 80, files_created: 0, files_modified: 1, files_deleted: 0, models: ["model-b"], implementation_assistance: "low", blockers: [], profiles: { display_name: "Ada" }, projects: { name: "Weather" } },
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0]).toMatchObject({ studentId: "student-a", seconds: 900, created: 1, modified: 3, high: 1 });
		expect([...groups[0].models]).toEqual(["model-a", "model-b"]);
	});
});
