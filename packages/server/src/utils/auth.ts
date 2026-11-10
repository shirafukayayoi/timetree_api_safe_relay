import { timingSafeEqual } from "node:crypto";

/** Relay は localhost からのアクセスだけを受け付ける。 */
export const isAllowedHost = (host: string | undefined): boolean => {
	if (!host) return false;
	const hostname = host.split(":")[0] ?? "";
	return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
};

/** Bearer トークンを一定時間比較で検証する。 */
export const isAuthorized = (header: string | undefined, token: string): boolean => {
	if (!header) return false;
	const match = /^Bearer\s+(.+)$/i.exec(header);
	if (!match?.[1]) return false;
	const provided = Buffer.from(match[1], "utf8");
	const expected = Buffer.from(token, "utf8");
	if (provided.length !== expected.length) return false;
	return timingSafeEqual(provided, expected);
};
