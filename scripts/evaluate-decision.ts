import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boundedStudentContext, type DecisionEngine } from "@pi-student/decision";
import { DeterministicDecisionEngine, EDUCATIONAL_INTENT_CHOICES } from "@pi-student/education/deterministic-decision-engine";
import { routeIntent } from "@pi-student/education/intent";
import { StudentQuestionLoop } from "@pi-student/education/student-question-loop";
import type { ProjectContext } from "@pi-student/education/project-context";
import { intentFixtures, sufficiencyFixtures } from "../packages/decision/test/fixtures.js";

type Accuracy = { correct: number; total: number };
const accuracy = <T>(rows: readonly T[], eligible: (row: T) => boolean, correct: (row: T) => boolean): Accuracy => {
	const relevant = rows.filter(eligible);
	return { correct: relevant.filter(correct).length, total: relevant.length };
};

/** Compare any candidate engine with the established deterministic workflow. No prompt text is stored. */
export async function evaluateDecision(engine: DecisionEngine, candidateName = "deterministic") {
	const questionLoop = new StudentQuestionLoop(new DeterministicDecisionEngine());
	const intents = [];
	for (const [index, fixture] of intentFixtures.entries()) {
		const baseline = routeIntent(fixture.text);
		const result = await engine.choose(boundedStudentContext("student-intent", fixture.text),
			"Which educational intent best describes the student's immediate request?", EDUCATIONAL_INTENT_CHOICES);
		const raw = result.probabilities && Object.entries(result.probabilities).sort((a, b) => b[1] - a[1])[0]?.[0];
		intents.push({ id: `intent-${index + 1}`, expected: fixture.expected, baseline: baseline.intent ?? null, raw: raw ?? result.value ?? null,
			accepted: result.value ?? null, fallback: result.value ?? baseline.intent ?? null,
			confidence: result.confidence ?? null, latencyMs: result.latencyMs, fallbackUsed: result.fallbackUsed,
			fallbackReason: result.fallbackReason ?? null });
	}
	const sufficiency = [];
	for (const fixture of sufficiencyFixtures) {
		const projectContext: ProjectContext | undefined = fixture.projectLanguages || fixture.projectFrameworks ? {
			languages: fixture.projectLanguages ?? [], frameworks: fixture.projectFrameworks ?? [], importantFiles: [], hasGit: false,
		} : undefined;
		const context = { stage: "understand" as const, intent: fixture.intent, studentMessage: fixture.text, projectContext };
		const baseline = await questionLoop.evaluate(context);
		const facts = [
			`Learning intent: ${fixture.intent}`,
			...(projectContext?.languages.length ? [`Project languages: ${projectContext.languages.join(", ")}`] : []),
			...(projectContext?.frameworks.length ? [`Project frameworks: ${projectContext.frameworks.join(", ")}`] : []),
		];
		const result = await engine.yesNo(boundedStudentContext("context-sufficiency", fixture.text, facts),
			"Is there enough information to move forward with the current educational task?");
		const raw = result.probability === undefined ? result.value ?? null : result.probability >= 0.5;
		const baselineEnough = !baseline.shouldAsk;
		sufficiency.push({ id: fixture.id, expected: fixture.enough, baseline: baselineEnough, raw,
			accepted: result.value ?? null, fallback: result.value ?? baselineEnough,
			confidence: result.confidence ?? null, latencyMs: result.latencyMs, fallbackUsed: result.fallbackUsed,
			fallbackReason: result.fallbackReason ?? null });
	}
	const latencies = [...intents, ...sufficiency].map(row => row.latencyMs).sort((a, b) => a - b);
	const summarize = <T extends { expected: unknown; baseline: unknown; raw: unknown; accepted: unknown; fallback: unknown; fallbackUsed: boolean }>(rows: T[]) => ({
		count: rows.length,
		baselineAccuracy: accuracy(rows, row => row.expected !== null, row => row.baseline === row.expected),
		candidateRawAccuracy: accuracy(rows, row => row.expected !== null && row.raw !== null, row => row.raw === row.expected),
		candidateAcceptedAccuracy: accuracy(rows, row => row.expected !== null && row.accepted !== null, row => row.accepted === row.expected),
		fallbackAccuracy: accuracy(rows, row => row.expected !== null, row => row.fallback === row.expected),
		disagreements: rows.filter(row => row.raw !== null && row.raw !== row.baseline).length,
		fallbackCount: rows.filter(row => row.fallbackUsed).length,
	});
	return {
		candidate: candidateName,
		intentSummary: summarize(intents), sufficiencySummary: summarize(sufficiency),
		latencyMs: { min: latencies[0] ?? null, median: latencies[Math.floor(latencies.length / 2)] ?? null,
			p95: latencies[Math.floor(latencies.length * 0.95)] ?? null, max: latencies.at(-1) ?? null },
		intents, sufficiency,
	};
}

async function main() {
	const args = process.argv.slice(2);
	const output = args[args.indexOf("--output") + 1];
	const candidatePath = args.includes("--candidate") ? args[args.indexOf("--candidate") + 1] : undefined;
	if (args.includes("--output") && !output || args.includes("--candidate") && !candidatePath) throw new Error("Missing flag value");
	let engine: DecisionEngine;
	let candidateName = "deterministic";
	if (candidatePath) {
		const specifier = candidatePath.startsWith(".") || candidatePath.startsWith("/") ? pathToFileURL(path.resolve(candidatePath)).href : candidatePath;
		const module = await import(specifier) as { createDecisionEngine?: () => DecisionEngine | Promise<DecisionEngine> };
		if (typeof module.createDecisionEngine !== "function") throw new Error("Candidate module must export createDecisionEngine()");
		engine = await module.createDecisionEngine();
		candidateName = candidatePath;
	} else engine = new DeterministicDecisionEngine();
	try {
		const report = await evaluateDecision(engine, candidateName);
		if (output) await writeFile(output, JSON.stringify(report, null, 2) + "\n");
		else process.stdout.write(JSON.stringify(report, null, 2) + "\n");
	} finally { await engine.close?.(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
