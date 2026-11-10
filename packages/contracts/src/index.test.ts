import { describe, expect, it } from "vitest";
import {
	createEventInputSchema,
	deleteEventInputSchema,
	eventJobSchema,
	idempotencyKeySchema,
	listEventsInputSchema,
	parseOperationInput,
	relayErrorStatus,
} from "./index.js";

describe("idempotencyKeySchema", () => {
	it("許可された文字だけのキーを受け入れる", () => {
		expect(idempotencyKeySchema.safeParse("event-2026.11:001_A").success).toBe(true);
	});

	it("空文字・長すぎるキー・使えない文字を拒否する", () => {
		expect(idempotencyKeySchema.safeParse("").success).toBe(false);
		expect(idempotencyKeySchema.safeParse("a".repeat(129)).success).toBe(false);
		expect(idempotencyKeySchema.safeParse("キー/1").success).toBe(false);
	});
});

describe("createEventInputSchema", () => {
	it("時刻付きの入力を受け入れる", () => {
		const input = {
			calendarId: "12345",
			title: "歯科検診",
			allDay: false,
			start: { dateTime: "2026-11-20T10:00:00+09:00" },
			end: { dateTime: "2026-11-20T11:00:00+09:00" },
			timezone: "Asia/Tokyo",
		};
		const result = createEventInputSchema.safeParse(input);
		expect(result.success).toBe(true);
	});

	it("終日予定を日付で受け入れる", () => {
		const result = createEventInputSchema.safeParse({
			calendarId: "12345",
			title: "旅行",
			allDay: true,
			start: { date: "2026-11-20" },
		});
		expect(result.success).toBe(true);
	});

	it("未知のフィールドを拒否する", () => {
		const result = createEventInputSchema.safeParse({
			calendarId: "12345",
			title: "予定",
			start: { date: "2026-11-20" },
			extra: true,
		});
		expect(result.success).toBe(false);
	});

	it("不正な日時形式を拒否する", () => {
		expect(
			createEventInputSchema.safeParse({
				calendarId: "12345",
				title: "予定",
				start: { dateTime: "2026-11-20 10:00" },
			}).success,
		).toBe(false);
	});
});

describe("deleteEventInputSchema", () => {
	it("allowSeries は省略可能", () => {
		expect(deleteEventInputSchema.safeParse({ calendarId: "1", eventId: "abc" }).success).toBe(true);
	});

	it("allowSeries: true を受け入れる", () => {
		expect(deleteEventInputSchema.safeParse({ calendarId: "1", eventId: "abc", allowSeries: true }).success).toBe(true);
	});
});

describe("listEventsInputSchema", () => {
	it("from/to を省略できる", () => {
		expect(listEventsInputSchema.safeParse({ calendarId: "1" }).success).toBe(true);
	});

	it("ISO 8601 の範囲を受け入れる", () => {
		expect(
			listEventsInputSchema.safeParse({
				calendarId: "1",
				from: "2026-11-01T00:00:00+09:00",
				to: "2026-11-30T23:59:59+09:00",
			}).success,
		).toBe(true);
	});
});

describe("eventJobSchema", () => {
	it("作成ジョブを検証する", () => {
		const job = {
			id: "0195f001-0000-7000-8000-000000000001",
			kind: "create",
			state: "created",
			profile: "account1",
			key: "event-001",
			request: {
				calendarId: "12345",
				title: "歯科検診",
				allDay: false,
				start: { dateTime: "2026-11-20T10:00:00+09:00" },
				end: { dateTime: "2026-11-20T11:00:00+09:00" },
				timezone: "Asia/Tokyo",
			},
			eventId: "abcd1234",
			failure: null,
			createdAt: "2026-11-10T10:00:00Z",
			updatedAt: "2026-11-10T10:00:01Z",
		};
		expect(eventJobSchema.safeParse(job).success).toBe(true);
	});
});

describe("parseOperationInput", () => {
	it("不正な入力で INVALID_INPUT エラーを投げる", () => {
		expect(() => parseOperationInput("createEvent", { calendarId: "" })).toThrowError(
			expect.objectContaining({ code: "INVALID_INPUT" }),
		);
	});

	it("正当な入力をそのまま返す", () => {
		const input = { calendarId: "1" };
		expect(parseOperationInput("listEvents", input)).toEqual(input);
	});
});

describe("relayErrorStatus", () => {
	it("すべてのエラーコードが HTTP ステータスに対応する", () => {
		for (const code of Object.keys(relayErrorStatus) as (keyof typeof relayErrorStatus)[]) {
			expect(relayErrorStatus[code]).toBeGreaterThan(0);
		}
		expect(relayErrorStatus.SERIES_DELETE_REQUIRED).toBe(409);
		expect(relayErrorStatus.SESSION_NOT_READY).toBe(503);
	});
});
