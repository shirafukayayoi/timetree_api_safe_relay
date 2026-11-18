import { createHash } from "node:crypto";
import rrule from "rrule";
import type { TimeTreeEvent } from "timetree-api-safe-contracts";
import { zonedToEpochMs } from "../timetree/client.js";
import { TimeTreeError } from "../timetree/errors.js";

const DAY_MS = 86_400_000;
const MAX_RANGE_MS = 366 * DAY_MS;
const MAX_OCCURRENCES = 10_000;

const overlaps = (event: TimeTreeEvent, from: number, to: number): boolean =>
	Date.parse(event.endAt) >= from && Date.parse(event.startAt) <= to;

/** RFC 5545 の DTSTART 用に、実時刻を予定のタイムゾーンの壁時計へ変換する。 */
const localStamp = (instant: string, timezone: string): string => {
	const parts = new Intl.DateTimeFormat("sv-SE", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date(instant));
	const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
	return `${value("year")}${value("month")}${value("day")}T${value("hour")}${value("minute")}${value("second")}`;
};

/** 基本形式のRFC日時を実時刻へ変換する。Zなしは指定した地域の壁時計。 */
const stampToEpoch = (stamp: string, timezone: string): number => {
	const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?$/.exec(stamp);
	if (!match) throw new Error("invalid recurrence date");
	const [, y, m, d, h = "00", mi = "00", s = "00", z] = match;
	const utc = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(h), Number(mi), Number(s));
	const expected = `${y}${m}${d}T${h}${mi}${s}`;
	if (!Number.isFinite(utc) || localStamp(new Date(utc).toISOString(), "UTC") !== expected)
		throw new Error("invalid recurrence date");
	if (z || timezone === "UTC") return utc;
	return zonedToEpochMs(Number(y), Number(m), Number(d), Number(h), Number(mi), Number(s), timezone);
};

/** rruleのTZID処理はホストのTZに依存するため、UTCの器で壁時計を計算して自前で実時刻へ戻す。 */
const floatingRule = (line: string, timezone: string): string => {
	if (line.startsWith("RRULE:")) {
		return line.replace(
			/UNTIL=([0-9TZ]+)/,
			(_match, value: string) =>
				`UNTIL=${localStamp(new Date(stampToEpoch(value, timezone)).toISOString(), timezone)}Z`,
		);
	}
	const match = /^(EXDATE|RDATE)(?:;TZID=([^;:]+)|;VALUE=DATE)?:([0-9TZ,]+)$/.exec(line);
	if (!match?.[3]) throw new Error("unsupported recurrence date");
	const [, kind, sourceTimezone, values] = match;
	const dates = values
		.split(",")
		.map(
			(value) => `${localStamp(new Date(stampToEpoch(value, sourceTimezone ?? timezone)).toISOString(), timezone)}Z`,
		);
	return `${kind}:${dates.join(",")}`;
};

/** 検証済みの有限範囲だけを展開する。無範囲の一覧は変更・削除用の元予定を保つ。 */
export const eventsInRange = (events: TimeTreeEvent[], from?: string, to?: string): TimeTreeEvent[] => {
	const fromMs = from === undefined ? Number.NEGATIVE_INFINITY : Date.parse(from);
	const toMs = to === undefined ? Number.POSITIVE_INFINITY : Date.parse(to);
	if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs > toMs) {
		throw new TimeTreeError("INVALID_INPUT", "予定の取得期間が不正です");
	}
	if (from === undefined || to === undefined) {
		// 片側だけの期間では無限系列を展開できない。繰り返しの元予定を欠落させず返す。
		return events.filter((event) => event.recurring || overlaps(event, fromMs, toMs));
	}
	if (toMs - fromMs > MAX_RANGE_MS) {
		throw new TimeTreeError("INVALID_INPUT", "繰り返し予定の取得期間は366日以内で指定してください");
	}
	const result: TimeTreeEvent[] = [];
	for (const event of events) {
		if (!event.recurrenceRules?.length) {
			if (overlaps(event, fromMs, toMs)) result.push(event);
			continue;
		}
		try {
			const rules = event.recurrenceRules;
			// 未知の形式や高頻度の系列は推測して展開せず、明示的に停止する。
			if (
				!rules.some((rule) => rule.startsWith("RRULE:")) ||
				rules.some(
					(rule) =>
						/[\r\n]/.test(rule) ||
						!/^(RRULE:|EXDATE[;:]|RDATE[;:])/.test(rule) ||
						(rule.startsWith("RRULE:") && !/^RRULE:FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;|$)/.test(rule)),
				)
			) {
				throw new Error("unsupported recurrence");
			}
			const timezone = event.allDay ? "UTC" : event.timezone;
			const duration = Date.parse(event.endAt) - Date.parse(event.startAt);
			if (!Number.isFinite(duration) || duration < 0 || duration > MAX_RANGE_MS) throw new Error("invalid duration");
			if (
				rules.some(
					(line) =>
						/(?:;|:)(?:INTERVAL|COUNT)=/.test(line) &&
						[...line.matchAll(/(?:;|:)(?:INTERVAL|COUNT)=([^;]+)/g)].some(
							(match) => !/^[1-9]\d*$/.test(match[1] ?? ""),
						),
				)
			) {
				throw new Error("invalid recurrence count");
			}
			const start = localStamp(event.startAt, timezone);
			const rule = rrule.rrulestr(
				`DTSTART:${start}Z\n${rules.map((line) => floatingRule(line, timezone)).join("\n")}`,
				{ forceset: true },
			);
			// 世界のUTCオフセットとDST差を含む余白を取り、最後に実時刻で厳密に絞る。
			const instances = rule.between(
				new Date(fromMs - duration - 2 * DAY_MS),
				new Date(toMs + 2 * DAY_MS),
				true,
				(_date, index) => index < MAX_OCCURRENCES,
			);
			if (instances.length >= MAX_OCCURRENCES) throw new Error("too many occurrences");
			for (const date of instances) {
				const wallTime = localStamp(date.toISOString(), "UTC");
				const instant = stampToEpoch(wallTime, timezone);
				const startAt = new Date(instant).toISOString();
				// 夏時間への移行で存在しない現地時刻は、別の時刻にずらさず除外する。
				if (localStamp(startAt, timezone) !== wallTime) continue;
				const occurrence: TimeTreeEvent = {
					...event,
					id: `occ_${createHash("sha256").update(`${event.id}|${startAt}`).digest("hex")}`,
					seriesId: event.id,
					startAt,
					endAt: new Date(instant + duration).toISOString(),
				};
				// 展開済みの各回を下流で再展開しない。
				delete occurrence.recurrenceRules;
				if (overlaps(occurrence, fromMs, toMs)) result.push(occurrence);
			}
			if (result.length > MAX_OCCURRENCES) throw new Error("too many occurrences");
		} catch {
			throw new TimeTreeError("UPSTREAM_CHANGED", "TimeTreeの繰り返し予定を安全に展開できません");
		}
	}
	return result;
};
