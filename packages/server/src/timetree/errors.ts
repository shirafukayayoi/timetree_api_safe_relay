import type { RelayErrorCode } from "timetree-api-safe-contracts";

/** TimeTree 通信・検証で使うエラー。code はそのまま Relay のエラーコードへ対応する。 */
export class TimeTreeError extends Error {
	readonly code: RelayErrorCode;

	constructor(code: RelayErrorCode, message: string) {
		super(message);
		this.name = "TimeTreeError";
		this.code = code;
	}
}

export const isTimeTreeError = (error: unknown): error is TimeTreeError => error instanceof TimeTreeError;
