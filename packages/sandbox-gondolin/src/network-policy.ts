import { isIP } from "node:net";
import { domainToASCII } from "node:url";

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
	if (!host || isLocalhostName(host) || isUnsafeIpAddress(host)) return true;
	return blockedHosts.some(blocked => {
		const normalized = canonicalHostname(blocked);
		return Boolean(normalized && (host === normalized || host.endsWith(`.${normalized}`)));
	});
}

export function isBlockedRequest(request: Request, blockedHosts: readonly string[]): boolean {
	try {
		const url = new URL(request.url);
		if (url.protocol !== "http:" && url.protocol !== "https:") return true;
		return isBlockedHostname(url.hostname, blockedHosts);
	} catch {
		// A malformed destination must not escape the network policy.
		return true;
	}
}

/** Blocks loopback, link-local, private, special-use, and multicast addresses. */
export function isUnsafeIpAddress(value: string): boolean {
	const host = canonicalHostname(value);
	if (!host) return true;
	if (isIP(host) === 4) return isUnsafeIpv4(host);
	if (isIP(host) === 6) return isUnsafeIpv6(host);
	return false;
}

function normalizeBlockedHost(value: string): string {
	if (typeof value !== "string") throw new Error("Sandbox blocked sites must be hostnames.");
	const host = canonicalHostname(value.trim());
	const validIp = host ? isIP(host) !== 0 : false;
	if (!host || host.length > 253 || (!validIp && (!host.includes(".") || host.split(".").some(label => !HOST_LABEL.test(label))))) {
		throw new Error(`Invalid sandbox blocked site: ${value}`);
	}
	return host;
}

function canonicalHostname(hostname: string): string | undefined {
	if (typeof hostname !== "string") return undefined;
	const trimmed = hostname.trim().toLowerCase();
	if (!trimmed || /[\u0000-\u0020/\\?#@]/u.test(trimmed)) return undefined;
	const withoutRootDot = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
	const unbracketed = withoutRootDot.startsWith("[") && withoutRootDot.endsWith("]")
		? withoutRootDot.slice(1, -1)
		: withoutRootDot;
	if (isIP(unbracketed) !== 0) return unbracketed;
	const ascii = domainToASCII(unbracketed).toLowerCase();
	return ascii || undefined;
}

function isUnsafeIpv4(value: string): boolean {
	const octets = value.split(".").map(Number);
	if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
	const [a, b] = octets;
	return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && (b === 0 || b === 2 || b === 168)) || (a === 198 && b >= 18 && b <= 19) ||
		(a === 198 && b === 51) || (a === 203 && b === 0) || a >= 224;
}

function isUnsafeIpv6(value: string): boolean {
	const groups = expandIpv6(value.toLowerCase());
	if (!groups) return true;
	const first = Number.parseInt(groups.slice(0, 4), 16);
	const second = Number.parseInt(groups.slice(4, 8), 16);
	const mappedIpv4 = groups.startsWith("00000000000000000000ffff") ? groups.slice(-8) : undefined;
	return first === 0 || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 ||
		(first & 0xff00) === 0xff00 || (first === 0x2001 && second === 0x0db8) ||
		(mappedIpv4 ? isUnsafeIpv4(`${Number.parseInt(mappedIpv4.slice(0, 2), 16)}.${Number.parseInt(mappedIpv4.slice(2, 4), 16)}.${Number.parseInt(mappedIpv4.slice(4, 6), 16)}.${Number.parseInt(mappedIpv4.slice(6, 8), 16)}`) : false);
}

function isLocalhostName(host: string): boolean {
	return host === "localhost" || host.endsWith(".localhost");
}

function expandIpv6(value: string): string | undefined {
	const parts = value.split("::");
	if (parts.length > 2) return undefined;
	const left = parts[0] ? parts[0].split(":") : [];
	const right = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
	if ([...left, ...right].some(group => !/^[0-9a-f]{1,4}$/u.test(group))) return undefined;
	const missing = 8 - left.length - right.length;
	if (parts.length === 1 && missing !== 0 || parts.length === 2 && missing < 1) return undefined;
	return [...left, ...Array.from({ length: missing }, () => "0"), ...right].join("").padStart(32, "0");
}
