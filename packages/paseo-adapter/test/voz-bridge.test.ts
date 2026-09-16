import { describe, expect, it } from "vitest";
import { extractAudio } from "@pi-student/paseo-adapter/voz-bridge";

describe("Voz bridge multipart audio", () => {
	it("reads the file even when model and options precede it", async () => {
		const audio = Buffer.from([82, 73, 70, 70, 0, 255, 13, 10]);
		const form = new FormData();
		form.set("model", "voz");
		form.set("response_format", "json");
		form.set("file", new Blob([audio]), "audio.wav");
		const request = new Request("http://localhost", { method: "POST", body: form });
		expect(await extractAudio(Buffer.from(await request.arrayBuffer()), request.headers.get("content-type")!)).toEqual(audio);
	});
	it("rejects multipart requests without a file", async () => {
		const form = new FormData();
		form.set("model", "voz");
		const request = new Request("http://localhost", { method: "POST", body: form });
		await expect(extractAudio(Buffer.from(await request.arrayBuffer()), request.headers.get("content-type")!)).rejects.toThrow("without an audio file");
	});
});
