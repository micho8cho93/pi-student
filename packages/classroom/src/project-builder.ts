import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface ProjectBrief {
	version: 1;
	goal: string;
	objectives: string[];
	expectations: string;
	structure: string[];
	constraints: string[];
	successCriteria: string[];
}

export interface ProjectBuilderMessage {
	role: "teacher" | "assistant";
	content: string;
}

export interface ProjectDraft {
	name: string;
	description: string;
	brief: ProjectBrief;
	requirements: Array<{ title: string; description: string }>;
	standards: Array<{ code: string; title: string }>;
}

export interface ProjectBuilderTurn {
	message: string;
	ready: boolean;
	draft?: ProjectDraft;
}

const BUILDER_PROMPT = `
You are the Pi Student project-design partner for a teacher. Help the teacher turn a rough idea into a clear, teachable coding project through a short conversation.

Ask only the highest-value questions needed to clarify the student-facing outcome, what students must build, the expected project structure, constraints, and how success will be evaluated. Be practical and concise. Do not invent standards or requirements the teacher has not implied. It is fine to ask one question at a time.

Return ONLY valid JSON with this shape:
{
  "message": "your next conversational reply to the teacher",
  "ready": false,
  "draft": null
}

When the teacher has supplied enough information, set ready to true and return a complete draft:
{
  "message": "a concise confirmation of the project you understood",
  "ready": true,
  "draft": {
    "name": "short project name",
    "description": "one or two sentence overview",
    "brief": {
      "version": 1,
      "goal": "the single student-facing project goal",
      "objectives": ["what students will learn or practice"],
      "expectations": "what the student should deliver and how they should work",
      "structure": ["the expected files, sections, or milestones"],
      "constraints": ["technology, scope, or process constraints"],
      "successCriteria": ["observable criteria that define a successful result"]
    },
    "requirements": [{"title": "requirement", "description": "what it means in practice"}],
    "standards": [{"code": "only if the teacher named one", "title": "standard title"}]
  }
}

Use empty arrays when a category is not applicable. A project is ready only when a student could understand what to make, the boundaries, and what to submit.
`;

type BuilderModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export function createProjectBuilder(runtime: ModelRuntime, model: BuilderModel): ProjectBuilder {
	return {
		async turn(history, input) {
			const messages = history.concat({ role: "teacher", content: input }).map((item, index) => ({
				// Simple requests only accept user messages. Prefixing the speaker keeps
				// the short teacher/assistant transcript unambiguous to every provider.
				role: "user" as const,
				content: `${item.role === "teacher" ? "Teacher" : "Assistant"}: ${item.content}`,
				timestamp: Date.now() + index,
			}));
			const response = await runtime.completeSimple(model, { systemPrompt: BUILDER_PROMPT, messages }, {
				reasoning: "low",
				temperature: 0.2,
				maxTokens: 1400,
			});
			const text = response.content.filter((block): block is { type: "text"; text: string } => block.type === "text").map(block => block.text).join("\n").trim();
			return parseBuilderResponse(text);
		},
	};
}

export interface ProjectBuilder {
	turn(history: ProjectBuilderMessage[], input: string): Promise<ProjectBuilderTurn>;
}

export function normalizeProjectBrief(value: unknown): ProjectBrief {
	const source = record(value);
	return {
		version: 1,
		goal: stringValue(source.goal),
		objectives: stringArray(source.objectives),
		expectations: stringValue(source.expectations),
		structure: stringArray(source.structure),
		constraints: stringArray(source.constraints),
		successCriteria: stringArray(source.successCriteria),
	};
}

export function formatProjectBrief(brief: Partial<ProjectBrief> | null | undefined): string {
	const normalized = normalizeProjectBrief(brief);
	return [
		`Goal: ${normalized.goal || "Not specified"}`,
		normalized.objectives.length ? `Learning objectives: ${normalized.objectives.join("; ")}` : "",
		normalized.expectations ? `Expectations: ${normalized.expectations}` : "",
		normalized.structure.length ? `Expected structure: ${normalized.structure.join("; ")}` : "",
		normalized.constraints.length ? `Constraints: ${normalized.constraints.join("; ")}` : "",
		normalized.successCriteria.length ? `Success criteria: ${normalized.successCriteria.join("; ")}` : "",
	].filter(Boolean).join("\n");
}

function parseBuilderResponse(text: string): ProjectBuilderTurn {
	const parsed = parseJson(text);
	if (!parsed) return { message: text || "Tell me a little more about what students should build.", ready: false };
	const source = record(parsed);
	const message = stringValue(source.message) || "What should students build and how will you know they have met the goal?";
	if (source.ready !== true || !source.draft) return { message, ready: false };
	const rawDraft = record(source.draft);
	const brief = normalizeProjectBrief(rawDraft.brief);
	const draft: ProjectDraft = {
		name: stringValue(rawDraft.name) || "Untitled project",
		description: stringValue(rawDraft.description),
		brief,
		requirements: recordArray(rawDraft.requirements).map(item => ({ title: stringValue(item.title), description: stringValue(item.description) })).filter(item => item.title),
		standards: recordArray(rawDraft.standards).map(item => ({ code: stringValue(item.code), title: stringValue(item.title) || stringValue(item.code) })).filter(item => item.code),
	};
	return { message, ready: true, draft };
}

function parseJson(text: string): unknown {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
	const candidate = fenced || text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
	try { return candidate ? JSON.parse(candidate) : undefined; } catch { return undefined; }
}

function record(value: unknown): Record<string, any> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function recordArray(value: unknown): Array<Record<string, any>> {
	return Array.isArray(value) ? value.map(record) : [];
}

function stringValue(value: unknown): string { return typeof value === "string" ? value.trim().slice(0, 4000) : ""; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.map(stringValue).filter(Boolean).slice(0, 30) : []; }
