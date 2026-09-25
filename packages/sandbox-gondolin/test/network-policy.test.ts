import { describe, expect, it } from "vitest";
import { createGondolinHttpHooks } from "../src/gondolin-runtime.js";
import { isBlockedHostname, isBlockedRequest, isUnsafeIpAddress, normalizeBlockedHosts } from "../src/network-policy.js";

describe("Gondolin outbound network policy", () => {
	it("blocks denied hostnames and their subdomains for HTTP and HTTPS", async () => {
		const { httpHooks } = createGondolinHttpHooks({
			isInternetAllowed: () => true,
			blockedHosts: () => ["example.org"],
		});
		const isRequestAllowed = httpHooks.isRequestAllowed!;

		for (const protocol of ["http", "https"]) {
			expect(await isRequestAllowed(new Request(`${protocol}://example.org/path`))).toBe(false);
			expect(await isRequestAllowed(new Request(`${protocol}://sub.example.org/path`))).toBe(false);
			expect(await isRequestAllowed(new Request(`${protocol}://notexample.org/path`))).toBe(true);
			expect(await isRequestAllowed(new Request(`${protocol}://school.example/path`))).toBe(true);
		}
	});

	it("checks the hostname again after DNS resolution", async () => {
		const { httpHooks } = createGondolinHttpHooks({
			isInternetAllowed: () => true,
			blockedHosts: () => ["example.org"],
		});
		const isIpAllowed = httpHooks.isIpAllowed!;

		await expect(isIpAllowed({ hostname: "sub.example.org", ip: "93.184.216.34", family: 4, port: 443, protocol: "https" })).resolves.toBe(false);
		await expect(isIpAllowed({ hostname: "school.example", ip: "93.184.216.34", family: 4, port: 443, protocol: "https" })).resolves.toBe(true);
	});

	it("keeps Gondolin's internal address guard active", async () => {
		const { httpHooks } = createGondolinHttpHooks({
			isInternetAllowed: () => true,
			blockedHosts: () => [],
		});

		await expect(httpHooks.isIpAllowed!({ hostname: "school.example", ip: "10.0.0.8", family: 4, port: 80, protocol: "http" })).resolves.toBe(false);
		await expect(httpHooks.isIpAllowed!({ hostname: "school.example", ip: "93.184.216.34", family: 4, port: 80, protocol: "http" })).resolves.toBe(true);
	});

	it("disables HTTP and HTTPS when project internet access is off", async () => {
		const { httpHooks } = createGondolinHttpHooks({
			isInternetAllowed: () => false,
			blockedHosts: () => [],
		});

		for (const protocol of ["http", "https"]) {
			expect(await httpHooks.isRequestAllowed!(new Request(`${protocol}://school.example/path`))).toBe(false);
		}
	});

	it("normalizes blocked hosts before authorization and blocks nested subdomains, ports, redirects, and lookalikes", async () => {
		const blocked = normalizeBlockedHosts([" Example.ORG. ", "sub.example.org"]);
		expect(blocked).toEqual(["example.org", "sub.example.org"]);
		for (const host of ["example.org", "EXAMPLE.ORG.", "a.b.example.org"]) expect(isBlockedHostname(host, blocked)).toBe(true);
		for (const host of ["notexample.org", "example.org.evil.test", "school.example"]) expect(isBlockedHostname(host, blocked)).toBe(false);
		expect(isBlockedRequest(new Request("https://example.org:8443/redirect"), blocked)).toBe(true);
		expect(isBlockedRequest(new Request("http://sub.example.org:80/"), blocked)).toBe(true);
		expect(isBlockedRequest(new Request("https://example.org.evil.test/"), blocked)).toBe(false);
	});

	it("fails closed for malformed hosts and unsafe IP destinations", () => {
		for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "192.0.2.1", "169.254.1.1", "0.0.0.0", "::", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) {
			expect(isUnsafeIpAddress(address), address).toBe(true);
			expect(isBlockedHostname(address, [])).toBe(true);
		}
		expect(isBlockedHostname("localhost", [])).toBe(true);
		expect(isBlockedHostname("service.localhost", [])).toBe(true);
		expect(isBlockedHostname("localhost.evil.test", [])).toBe(false);
		expect(isUnsafeIpAddress("93.184.216.34")).toBe(false);
		expect(isBlockedRequest({ url: "https://[not-an-ip]/" } as Request, [])).toBe(true);
		expect(() => normalizeBlockedHosts(["https://example.org/path"])).toThrow();
		expect(() => normalizeBlockedHosts(["bad host"])).toThrow();
	});
});
