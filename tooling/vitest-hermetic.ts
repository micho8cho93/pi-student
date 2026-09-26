import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Tests run on developer machines with real Pi credentials, installed models,
 * classroom sign-ins and provider API keys. Code under test reads those from
 * `~/.pi/agent`, `~/.pi-student` and the environment, so a test could pass
 * locally only because the developer happens to have a configured model, and
 * fail on a clean CI runner. Point every configuration root at an empty
 * temporary directory and drop credential-like variables for the whole run.
 * Tests that need configuration create it explicitly.
 */
const CREDENTIAL_VARIABLE = /(?:API_KEY|_TOKEN|ACCESS_KEY|SECRET|PASSWORD|CREDENTIALS)$/i;
const CONFIG_VARIABLES = ["PI_STUDENT_SUPABASE_URL", "PI_STUDENT_SUPABASE_PUBLISHABLE_KEY", "PI_STUDENT_MODEL_GATEWAY_URL",
	"OLLAMA_HOST", "PASEO_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"];

export default function setup(): () => void {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-student-tests-"));
	for (const name of Object.keys(process.env)) {
		if (CREDENTIAL_VARIABLE.test(name) || CONFIG_VARIABLES.includes(name)) delete process.env[name];
	}
	process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
	process.env.PI_STUDENT_HOME = path.join(root, "pi-student");
	return () => rmSync(root, { recursive: true, force: true });
}
