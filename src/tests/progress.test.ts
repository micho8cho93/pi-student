import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { cueText, createStartupCueLoader, createTerminalWorkingProgress, fitTerminalLine, LEARNING_CUES, toolLearningCue } from "../terminal/progress.js";

describe("student-facing progress cues", () => {
	it("maps tool activity to an understandable milestone", () => {
		expect(toolLearningCue("read_file").label).toBe("Inspecting the relevant files");
		expect(toolLearningCue("bash").label).toBe("Running a check");
		expect(toolLearningCue("edit_file").label).toBe("Making the proposed change");
		expect(cueText(LEARNING_CUES[0])).toContain("Understanding the request");
	});

	it("keeps startup animation silent for piped output", () => {
		let output = "";
		const stream = new Writable({
			write(chunk, _encoding, callback) {
				output += chunk.toString();
				callback();
			},
		});
		const loader = createStartupCueLoader(stream);
		loader.start();
		loader.stop();
		expect(output).toBe("");
	});

	it("keeps educational facts out of the pre-TUI terminal loader", () => {
		let output = "";
		const stream = new Writable({
			write(chunk, _encoding, callback) {
				output += chunk.toString();
				callback();
			},
		}) as Writable & { isTTY: boolean; columns: number };
		stream.isTTY = true;
		stream.columns = 80;
		const loader = createStartupCueLoader(stream);
		loader.start();
		loader.stop();
		expect(output).toContain("Starting Pi Student");
		expect(output).not.toContain(LEARNING_CUES[0].fact);
	});

	it("fits animated frames to one physical terminal row", () => {
		expect(fitTerminalLine("123456789", 8)).toBe("1234567…");
		expect(fitTerminalLine("short", 8)).toBe("short");
	});

	it("writes activity on its own durable line while the spinner continues", () => {
		let output = "";
		const stream = new Writable({
			write(chunk, _encoding, callback) {
				output += chunk.toString();
				callback();
			},
		}) as Writable & { isTTY: boolean; columns: number };
		stream.isTTY = true;
		stream.columns = 100;
		const progress = createTerminalWorkingProgress(stream);
		progress.start();
		progress.writeLine("✓ edit finished");
		progress.stop();
		expect(output).toContain("✓ edit finished\n");
	});
});
