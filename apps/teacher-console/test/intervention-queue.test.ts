import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dashboardPage } from "../src/dashboard-page.js";

it("offers an explainable teacher queue with notes and manual disposition", () => {
	const page = dashboardPage({ url: "https://example.test", publishableKey: "public" });
	expect(page).toContain('id="side-interventions"');
	expect(page).toContain('id="interventions-view"');
	expect(page).toContain("refresh_teacher_interventions");
	expect(page).toContain("db.from('intervention_items')");
	expect(page).toContain(".eq('class_id',classId).eq('status',status)");
	expect(page).toContain("View session evidence");
	expect(page).toContain("Save note");
	expect(page).toContain("Dismiss");
	expect(page).toContain("Resolve");
	expect(page).toContain("These items do not message or grade students.");
	expect(page).not.toContain("student is lazy");
	const script = page.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
	expect(script).toBeDefined();
	expect(spawnSync(process.execPath, ["--check", "--input-type=module"], { input: script, encoding: "utf8" }).status).toBe(0);
});

it("keeps priority deterministic when Laya is absent or disagrees", () => {
	const migration = readFileSync(new URL("../../../infra/supabase/migrations/20260926133922_teacher_intervention_queue.sql", import.meta.url), "utf8");
	const refresh = migration.slice(migration.indexOf("create function public.refresh_teacher_interventions"));
	expect(refresh).toContain("if not private.is_class_teacher(class_id_input)");
	expect(refresh).toContain("from public.learning_evidence e");
	expect(refresh).not.toMatch(/Laya|DecisionEngine|model_score|model_classification|total_tokens/i);
	expect(refresh).toContain("case when failure_count >= 5 then 'high' else 'medium' end");
});
