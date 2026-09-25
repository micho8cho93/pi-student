import { describe, expect, it } from "vitest";
import { createGondolinHttpHooks } from "../src/gondolin-runtime.js";

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
});
