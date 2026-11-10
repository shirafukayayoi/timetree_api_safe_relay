import type { RelayErrorCode } from "timetree-api-safe-contracts";
import { relayErrorStatus } from "timetree-api-safe-contracts";
import type { Context } from "hono";

/** エラーからRelayのエラーコードを取り出す。未知のエラーは UPSTREAM_CHANGED とする。 */
export const errorCode = (error: unknown): RelayErrorCode => {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = String((error as { code: unknown }).code) as RelayErrorCode;
		if (code in relayErrorStatus) return code;
	}
	return "UPSTREAM_CHANGED";
};

export const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : "TimeTreeから予期しない応答を受け取りました";

/** エラーをRelayのエラー応答へ変換する。 */
export const fail = (c: Context, error: unknown) => {
	const code = errorCode(error);
	const status = relayErrorStatus[code];
	return c.json({ error: { code, message: errorMessage(error) } }, status);
};
