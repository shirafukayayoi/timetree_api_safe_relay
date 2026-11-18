import { describe, expect, it } from "vitest";
import { eventsInRange } from "../src/events/recurrence.js";
import { makeEvent } from "./helpers.js";

const weekly = () =>
	makeEvent({
		id: "series-1",
		title: "週次授業",
		startAt: "2026-11-11T10:30:00.000Z",
		endAt: "2026-11-11T11:45:00.000Z",
		recurring: true,
		recurrenceRules: ["RRULE:FREQ=WEEKLY", "EXDATE:20261223T103000Z"],
	});
const from = "2026-11-18T00:00:00+09:00";
const to = "2026-12-31T23:59:59+09:00";

describe("繰り返し予定の期間展開", () => {
	it("過去に始まった毎週の系列を取得し、休講日を除外する", () => {
		const events = eventsInRange([weekly()], from, to);
		expect(events).toHaveLength(6);
		expect(events[0]?.startAt).toBe("2026-11-18T10:30:00.000Z");
		expect(events[0]?.endAt).toBe("2026-11-18T11:45:00.000Z");
		expect(events.every((e) => e.seriesId === "series-1" && e.recurring && !e.recurrenceRules)).toBe(true);
		expect(events.some((e) => e.startAt.startsWith("2026-12-23"))).toBe(false);
		expect(new Set(events.map((e) => e.id)).size).toBe(6);
	});

	it("各回のIDは取得期間が変わっても安定する", () => {
		const first = eventsInRange([weekly()], from, to)[0];
		const second = eventsInRange([weekly()], "2026-11-17T00:00:00Z", "2026-11-19T00:00:00Z")[0];
		expect(first?.id).toBe(second?.id);
		expect(first?.id).toMatch(/^occ_[a-f0-9]{64}$/);
	});

	it("BYDAYとCOUNTを保ち、終了した系列を復活させない", () => {
		const event = { ...weekly(), recurrenceRules: ["RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=3"] };
		const result = eventsInRange([event], from, to);
		expect(result.map((e) => e.startAt)).toEqual(["2026-11-20T10:30:00.000Z", "2026-11-27T10:30:00.000Z"]);
	});

	it("UNTILを越える開催日を追加しない", () => {
		const event = { ...weekly(), recurrenceRules: ["RRULE:FREQ=WEEKLY;UNTIL=20261125T103000Z"] };
		expect(eventsInRange([event], from, to).map((e) => e.startAt)).toEqual([
			"2026-11-18T10:30:00.000Z",
			"2026-11-25T10:30:00.000Z",
		]);
	});

	it("複数日終日の期間とUTC暦日を保持する", () => {
		const event = makeEvent({
			allDay: true,
			recurring: true,
			startAt: "2026-11-11T00:00:00.000Z",
			endAt: "2026-11-12T00:00:00.000Z",
			recurrenceRules: ["RRULE:FREQ=WEEKLY;COUNT=2"],
		});
		const [instance] = eventsInRange([event], from, to);
		expect(instance?.startAt).toBe("2026-11-18T00:00:00.000Z");
		expect(instance?.endAt).toBe("2026-11-19T00:00:00.000Z");
	});

	it("DSTをまたいでも現地の開始時刻と所要時間を保持する", () => {
		const event = makeEvent({
			timezone: "America/New_York",
			recurring: true,
			startAt: "2026-10-28T14:00:00.000Z",
			endAt: "2026-10-28T15:00:00.000Z",
			recurrenceRules: ["RRULE:FREQ=WEEKLY;COUNT=2"],
		});
		expect(eventsInRange([event], "2026-10-28T00:00:00Z", "2026-11-05T00:00:00Z").map((e) => e.startAt)).toEqual([
			"2026-10-28T14:00:00.000Z",
			"2026-11-04T15:00:00.000Z",
		]);
	});

	it("期間開始前に始まった日またぎの開催回も返す", () => {
		const event = { ...weekly(), startAt: "2026-11-10T14:00:00.000Z", endAt: "2026-11-10T17:00:00.000Z" };
		expect(eventsInRange([event], from, "2026-11-18T01:00:00+09:00")).toHaveLength(1);
	});

	it("隔週・追加日・地域指定の除外日を反映する", () => {
		const event = {
			...weekly(),
			recurrenceRules: [
				"RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3",
				"RDATE:20261118T103000Z",
				"EXDATE;TZID=Asia/Tokyo:20261125T193000",
			],
		};
		expect(eventsInRange([event], from, to).map((e) => e.startAt)).toEqual([
			"2026-11-18T10:30:00.000Z",
			"2026-12-09T10:30:00.000Z",
		]);
	});

	it("夏時間の開始で存在しない現地時刻を別の時刻へずらさない", () => {
		const event = makeEvent({
			timezone: "America/New_York",
			recurring: true,
			startAt: "2026-03-01T07:30:00.000Z",
			endAt: "2026-03-01T08:30:00.000Z",
			recurrenceRules: ["RRULE:FREQ=WEEKLY"],
		});
		expect(eventsInRange([event], "2026-03-01T00:00:00Z", "2026-03-16T00:00:00Z").map((e) => e.startAt)).toEqual([
			"2026-03-01T07:30:00.000Z",
			"2026-03-15T06:30:00.000Z",
		]);
	});

	it("無範囲の取得と元データを変更せず、片側指定でも系列を隠さない", () => {
		const event = weekly();
		expect(eventsInRange([event])).toEqual([event]);
		expect(eventsInRange([event], from)).toEqual([event]);
		eventsInRange([event], from, to);
		expect(event.recurrenceRules).toHaveLength(2);
		expect(event.id).toBe("series-1");
	});

	it("通常予定は期間で絞り、ゼロ分の予定と境界の重なりも維持する", () => {
		const event = makeEvent({ startAt: from, endAt: from });
		expect(
			eventsInRange([event, makeEvent({ endAt: "2026-11-01T00:00:00Z", startAt: "2026-11-01T00:00:00Z" })], from, to),
		).toEqual([event]);
	});

	it("逆転期間と366日を超える範囲は拒否する", () => {
		expect(() => eventsInRange([], to, from)).toThrow();
		expect(() => eventsInRange([], from, "2028-11-18T00:00:00+09:00")).toThrow();
	});

	it.each([
		"RRULE:FREQ=SECONDLY",
		"RRULE:FREQ=BOGUS",
		"RRULE:FREQ=WEEKLY\nDTSTART:20200101T000000Z",
		"BOGUS:test",
		"RRULE:FREQ=WEEKLY;INTERVAL=0",
		"RRULE:FREQ=WEEKLY;COUNT=-1",
		"EXDATE:20261301T103000Z",
	])("未知または高頻度の形式は予定を捏造せず停止する: %s", (rule) => {
		expect(() => eventsInRange([{ ...weekly(), recurrenceRules: [rule] }], from, to)).toThrow();
	});
});
