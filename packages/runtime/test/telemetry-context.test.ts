import { expect, it } from "vitest";
import { telemetrySelection } from "../src/telemetry-integration.js";

it("keeps the host workspace binding out of student telemetry", () => {
	expect(telemetrySelection({ workspacePath: "/Users/student/private-project", classId: "class", projectId: "project" }))
		.toEqual({ classId: "class", projectId: "project" });
});
