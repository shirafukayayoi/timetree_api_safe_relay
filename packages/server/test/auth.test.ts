import { describe, expect, it } from "vitest";
import { isAllowedHost, isAuthorized } from "../src/utils/auth.js";

describe("isAllowedHost", () => {
	it("localhostだけを許可する", () => {
		expect(isAllowedHost("127.0.0.1:3100")).toBe(true);
		expect(isAllowedHost("localhost:3100")).toBe(true);
		expect(isAllowedHost("[::1]:3100")).toBe(true);
		expect(isAllowedHost("example.com")).toBe(false);
		expect(isAllowedHost("192.168.0.1:3100")).toBe(false);
		expect(isAllowedHost(undefined)).toBe(false);
	});
});

describe("isAuthorized", () => {
	const token = "test-token-1234567890";

	it("正しいBearerトークンを許可する", () => {
		expect(isAuthorized(`Bearer ${token}`, token)).toBe(true);
		expect(isAuthorized(`bearer ${token}`, token)).toBe(true);
	});

	it("誤ったトークン・形式なしを拒否する", () => {
		expect(isAuthorized("Bearer wrong-token", token)).toBe(false);
		expect(isAuthorized(undefined, token)).toBe(false);
		expect(isAuthorized(token, token)).toBe(false);
		expect(isAuthorized("", token)).toBe(false);
	});
});
