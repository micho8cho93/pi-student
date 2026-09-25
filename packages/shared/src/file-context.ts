import path from "node:path";

/** Deny known credential locations even when a caller explicitly selects the file. */
export function isSensitiveContextPath(filePath: string): boolean {
	const parts = filePath.replaceAll("\\", "/").split("/").filter(Boolean).map(part => part.toLowerCase());
	if (parts.some(part => [".ssh", ".aws", ".azure", ".gcloud", "gcloud", ".docker", ".kube", ".gnupg", "credentials", "secrets"].includes(part))) return true;
	const name = path.posix.basename(parts.join("/"));
	return /^\.env(?:\..*)?$|^\.npmrc$|^\.netrc$|^\.pypirc$|^\.dockercfg$|^\.git-credentials$|^auth\.json$|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$|^known_hosts$|^(?:client[-_]?secret|oauth[-_]?secret|service[-_]?account)(?:[-_.].*)?$|^application_default_credentials\.json$|^credentials(?:[-_.].*)?$|^secrets?(?:[-_.].*)?$|^tokens?(?:[-_.].*)?$|^passwords?(?:[-_.].*)?$|^private[-_]?keys?(?:[-_.].*)?$|^.*\.(?:pem|key|p12|pfx|jks|keystore|tfvars(?:\.json)?|tfstate(?:\.backup)?)$/i.test(name);
}
