import { expect, it } from "vitest";
import { isSensitiveContextPath } from "../src/file-context.js";

it("excludes known secret files and credential directories from automatic context", () => {
	for (const file of [".env", ".env.local", "src/private-key.ts", "credentials.json", "token.json", "id_rsa", ".ssh/config.json",
		".aws/credentials", ".config/gcloud/credentials.db", ".docker/config.json", ".kube/config", "client_secret.json",
		"certs/client.pem", "terraform.tfstate", "terraform.tfstate.backup", "production.tfvars.json"]) {
		expect(isSensitiveContextPath(file), file).toBe(true);
	}
	for (const file of ["src/main.ts", "src/profile-view.ts", "README.md"]) {
		expect(isSensitiveContextPath(file), file).toBe(false);
	}
});
