import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Tests run on developer machines with real Pi credentials, installed models,
 * classroom sign-ins and provider API keys. Code under test reads those from
 * `~/.pi/agent`, `~/.pi-student`, `~/.paseo` and the environment, so a test could
 * pass locally only because the developer happens to have a configured model, and
 * fail on a clean CI runner. Point the home directory and every configuration root
 * at an empty temporary directory and drop credential-like and product variables
 * for the whole run. Tests that need configuration create it explicitly.
 */
const CREDENTIAL_VARIABLE = /(?:API_KEY|_TOKEN|ACCESS_KEY|SECRET|PASSWORD|CREDENTIALS|_BASE_URL)$/i;
const PRODUCT_VARIABLE = /^(?:PI_|PASEO_|OLLAMA_|GONDOLIN_|SANDBOX_MODE$|XDG_)/;
/** Explicit test inputs, not developer configuration. */
const TEST_VARIABLES = new Set(["PI_STUDENT_TEST_BROWSER"]);

export default function setup(): () => void {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-student-tests-"));
	for (const name of Object.keys(process.env)) {
		if (TEST_VARIABLES.has(name)) continue;
		if (CREDENTIAL_VARIABLE.test(name) || PRODUCT_VARIABLE.test(name)) delete process.env[name];
	}
	const home = path.join(root, "home");
	mkdirSync(home);
	// os.homedir() reads HOME (USERPROFILE on Windows); libraries fall back to it for their configuration.
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.XDG_CONFIG_HOME = path.join(home, ".config");
	process.env.XDG_CACHE_HOME = path.join(home, ".cache");
	process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
	process.env.XDG_STATE_HOME = path.join(home, ".local", "state");
	process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
	process.env.PI_STUDENT_HOME = path.join(root, "pi-student");
	// Cleanup must not decide the run: a leftover directory in the OS temp directory is harmless.
	return () => { try { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch {} };
}
