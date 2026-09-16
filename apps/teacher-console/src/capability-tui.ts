import type { Interface } from "node:readline/promises";
import { ACCESSIBILITY_FIELDS, CAPABILITY_FIELDS, parseCapabilityPolicy, type CapabilityPolicy } from "@pi-student/policy/capability-policy";

export async function editCapabilities(readline: Interface, write: (text: string) => void, value: unknown): Promise<CapabilityPolicy | undefined> {
	const draft = parseCapabilityPolicy(value);
	const fields = [...CAPABILITY_FIELDS.map(([key, label]) => ({ key, label, accessibility: false })), ...ACCESSIBILITY_FIELDS.map(([key, label]) => ({ key, label, accessibility: true }))];
	while (true) {
		write("\nPROJECT CAPABILITIES\n");
		fields.forEach((item, i) => write(`${i + 1}. ${item.accessibility ? "Accessibility · " : ""}${item.label}: ${item.accessibility ? draft.accessibility[item.key as keyof typeof draft.accessibility] : draft[item.key as keyof CapabilityPolicy]}\n`));
		write(`Reasoning: ${draft.reasoningLevels.join(", ")}\nModels: ${draft.models.join(", ") || "student choice"}\nLimits: ${JSON.stringify(draft.limits)}\n`);
		const input = (await readline.question("Number to toggle · levels · models · limits · save · cancel › ")).trim();
		if (input === "cancel" || !input) return;
		if (input === "save") return parseCapabilityPolicy(draft);
		const field = fields[Number(input) - 1];
		if (field) {
			if (field.accessibility) { const key = field.key as keyof typeof draft.accessibility; draft.accessibility[key] = !draft.accessibility[key]; }
			else { const key = field.key as (typeof CAPABILITY_FIELDS)[number][0]; draft[key] = !draft[key]; }
		} else if (input === "levels") {
			const levels = (await readline.question("Enabled levels, comma separated (off,minimal,low,medium,high,xhigh,max) › ")).split(",").map(x => x.trim());
			try { draft.reasoningLevels = parseCapabilityPolicy({ ...draft, reasoningLevels: levels }).reasoningLevels; } catch (error) { write(`${error}\n`); }
		} else if (input === "models") {
			const models = (await readline.question("Approved provider/model IDs, comma separated; blank for student choice › ")).split(",").map(x => x.trim()).filter(Boolean);
			try { draft.models = parseCapabilityPolicy({ ...draft, models }).models; } catch (error) { write(`${error}\n`); }
		} else if (input === "limits") {
			const limits = { ...draft.limits };
			for (const key of ["minutes", "turns", "tokens", "cost"] as const) { const raw = (await readline.question(`${key} (blank for unlimited) › `)).trim(); limits[key] = raw ? Number(raw) : null; }
			try { draft.limits = parseCapabilityPolicy({ ...draft, limits }).limits; } catch (error) { write(`${error}\n`); }
		}
	}
}
