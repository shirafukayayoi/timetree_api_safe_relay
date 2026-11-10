import { z } from "zod";

export * from "./events.js";
export * from "./accounts.js";

/** Relay が返すエラーコードと HTTP ステータスの対応。 */
export const relayErrorCodeSchema = z.enum([
	"AUTH_REQUIRED",
	"SESSION_NOT_READY",
	"UPSTREAM_CHANGED",
	"RATE_LIMITED",
	"NOT_FOUND",
	"INVALID_INPUT",
	"UNKNOWN_PROFILE",
	"IDEMPOTENCY_CONFLICT",
	"SERIES_DELETE_REQUIRED",
]);

export type RelayErrorCode = z.infer<typeof relayErrorCodeSchema>;

export const relayErrorStatus: Record<RelayErrorCode, 400 | 401 | 404 | 409 | 429 | 502 | 503> = {
	AUTH_REQUIRED: 401,
	SESSION_NOT_READY: 503,
	UPSTREAM_CHANGED: 502,
	RATE_LIMITED: 429,
	NOT_FOUND: 404,
	INVALID_INPUT: 400,
	UNKNOWN_PROFILE: 400,
	IDEMPOTENCY_CONFLICT: 409,
	SERIES_DELETE_REQUIRED: 409,
};

export const relayErrorSchema = z.strictObject({
	error: z.strictObject({
		code: relayErrorCodeSchema,
		message: z.string(),
	}),
});

export type RelayErrorBody = z.infer<typeof relayErrorSchema>;
