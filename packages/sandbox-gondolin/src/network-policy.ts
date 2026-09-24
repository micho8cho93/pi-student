import { domainToASCII } from "node:url";
import { isIP } from "node:net";

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_BLOCKED_HOSTS = 500;

export function normalizeBlockedHosts(hosts: readonly string[] | undefined): string[] {
	if (hosts === undefined) return [];
	if (!Array.isArray(hosts) || hosts.length > MAX_BLOCKED_HOSTS) {
		throw new Error("Sandbox blocked sites must be a list of at most 500 hostnames.");
	}
	return [...new Set(hosts.map(normalizeBlockedHost))];
}

export function isBlockedHostname(hostname: string, blockedHosts: readonly string[]): boolean {
	const host = canonicalHostname(hostname);
	if (!host) return true;
	return blockedHosts.some(blocked => host === blocked || host.endsWith(`.${blocked}`));
}

export function isBlockedRequest(request: Request, blockedHosts: readonly string[]): boolean {
	try {
		return isBlockedHostname(new URL(request.url).hostname, blockedHosts);
	} catch {
		// A malformed destination must not escape the network policy.
		return true;
	}
}

function normalizeBlockedHost(value: string): string {
	if (typeof value !== "string") throw new Error("Sandbox blocked sites must be hostnames.");
	const host = canonicalHostname(value.trim());
	if (!host || !host.includes(".") || host.length > 253 || host.split(".").some(label => !HOST_LABEL.test(label))) {
		throw new Error(`Invalid sandbox blocked site: ${value}`);
	}
	return host;
}

function canonicalHostname(hostname: string): string | undefined {
	const withoutRootDot = hostname.trim().replace(/\.$/, "").toLowerCase();
	const unbracketed = withoutRootDot.startsWith("[") && withoutRootDot.endsWith("]")
		? withoutRootDot.slice(1, -1)
		: withoutRootDot;
	if (isIP(unbracketed) === 6) return unbracketed;
	const ascii = domainToASCII(withoutRootDot).toLowerCase();
	return ascii || undefined;
}
