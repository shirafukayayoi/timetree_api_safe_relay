import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type FetchLike, TimeTreeClient, boundaryToEpochMs, zonedToEpochMs } from "../src/timetree/client.js";
import { TimeTreeError } from "../src/timetree/errors.js";
import { htmlResponse, htmlWithCsrf, jsonResponse, tempDir } from "./helpers.js";

const sessionFileIn = (value = "sess-1"): string => {
	const dir = tempDir();
	const file = join(dir, "session.json");
	writeFileSync(file, JSON.stringify({ cookies: [{ name: "_session_id", value }] }), "utf8");
	return file;
};

const userHandler = () => jsonResponse(200, { user: { id: 42, name: "太郎", email: null } });

describe("TimeTreeClient", () => {
	it("ログインユーザーを取得してreadyになる", async () => {
		const client = new TimeTreeClient({
			profileName: "p",
			sessionFile: sessionFileIn(),
			fetchImpl: ((url: string) => {
				if (url === "https://timetreeapp.com/api/v1/user") return userHandler();
				throw new Error(`unexpected ${url}`);
			}) as FetchLike,
		});
		const user = await client.checkSession();
		expect(user.id).toBe(42);
		expect(client.state).toBe("ready");
	});

	it("401でSESSION_NOT_READYになりlogin_requiredへ移る", async () => {
		const client = new TimeTreeClient({
			profileName: "p",
			sessionFile: sessionFileIn(),
			fetchImpl: (() => jsonResponse(401, {})) as FetchLike,
		});
		await expect(client.checkSession()).rejects.toMatchObject({ code: "SESSION_NOT_READY" });
		expect(client.state).toBe("login_required");
	});

	it("通信失敗はTRANSPORT_ERRORになる", async () => {
		const client = new TimeTreeClient({
			profileName: "p",
			sessionFile: sessionFileIn(),
			fetchImpl: (async () => {
				throw new Error("network down");
			}) as FetchLike,
		});
		await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
		expect(client.state).toBe("unknown");
	});

	it("CSRFトークンを取得し、422は1回だけ再試行する", async () => {
		let csrfCalls = 0;
		let createCalls = 0;
		const fetchImpl: FetchLike = (url, init) => {
			if (url === "https://timetreeapp.com/calendars") {
				csrfCalls += 1;
				return htmlResponse(200, htmlWithCsrf(`tok-${csrfCalls}`));
			}
			if (url === "https://timetreeapp.com/api/v1/calendar/cal-1/event") {
				createCalls += 1;
				const headers = init.headers as Record<string, string>;
				if (createCalls === 1 && headers["X-CSRF-Token"] === "tok-1") {
					return jsonResponse(422, { error: "csrf" });
				}
				return jsonResponse(201, { event: { uuid: "ev-1", title: "予定" } });
			}
			throw new Error(`unexpected ${url}`);
		};
		const client = new TimeTreeClient({
			profileName: "p",
			sessionFile: sessionFileIn(),
			fetchImpl,
		});
		await client.checkSession().catch(() => undefined);
		const body = await client.createEvent("cal-1", { title: "予定" });
		expect(createCalls).toBe(2);
		expect(csrfCalls).toBe(2);
		expect(body).toEqual({ event: { uuid: "ev-1", title: "予定" } });
	});

	it("events/syncのchunkページングを最後まで読む", async () => {
		let calls = 0;
		const fetchImpl: FetchLike = (url) => {
			if (url === "https://timetreeapp.com/api/v1/calendar/cal-1/events/sync") {
				calls += 1;
				return jsonResponse(200, {
					events: [
						{
							uuid: "ev-1",
							title: "予定1",
							all_day: false,
							start_at: 1732086000000,
							end_at: 1732089600000,
							start_timezone: "Asia/Tokyo",
							note: null,
							location: null,
							label_id: 1,
							attendees: [42],
							recurrences: [],
							category: 1,
							url: null,
							updated_at: 1732086000000,
						},
					],
					chunk: true,
					since: 100,
				});
			}
			if (url === "https://timetreeapp.com/api/v1/calendar/cal-1/events/sync?since=100") {
				calls += 1;
				return jsonResponse(200, {
					events: [
						{
							uuid: "ev-2",
							title: "予定2",
							all_day: true,
							start_at: 1732172400000,
							end_at: 1732258799999,
							start_timezone: "Asia/Tokyo",
							recurrences: ["RRULE:FREQ=WEEKLY"],
							category: 1,
						},
					],
					chunk: false,
				});
			}
			throw new Error(`unexpected ${url}`);
		};
		const client = new TimeTreeClient({
			profileName: "p",
			sessionFile: sessionFileIn(),
			fetchImpl,
		});
		const events = await client.listEvents("cal-1");
		expect(calls).toBe(2);
		expect(events).toHaveLength(2);
		expect(events[0]?.id).toBe("ev-1");
		expect(events[0]?.recurring).toBe(false);
		expect(events[0]?.startAt).toBe(new Date(1732086000000).toISOString());
		expect(events[1]?.recurring).toBe(true);
		expect(events[1]?.allDay).toBe(true);
		expect(events[1]?.recurrenceRules).toEqual(["RRULE:FREQ=WEEKLY"]);
	});

	it("未知の繰り返し定義を推測して正規化しない", async () => {
		const client = new TimeTreeClient({
			profileName: "p",
			sessionFile: sessionFileIn(),
			fetchImpl: (() =>
				jsonResponse(200, {
					events: [
						{
							uuid: "bad",
							title: "予定",
							start_at: 1732086000000,
							end_at: 1732089600000,
							recurrences: [{ freq: "weekly" }],
						},
					],
					chunk: false,
				})) as FetchLike,
		});
		await expect(client.listEvents("cal-1")).rejects.toMatchObject({ code: "UPSTREAM_CHANGED" });
	});

	it("Set-Cookieでセッションが更新されたら同じファイルへ保存する", async () => {
		const file = sessionFileIn("sess-1");
		const fetchImpl: FetchLike = (url) => {
			if (url === "https://timetreeapp.com/api/v1/calendar/cal-1/event") {
				return jsonResponse(
					201,
					{ event: { uuid: "ev-1" } },
					{
						"set-cookie": "_session_id=sess-2; Path=/; HttpOnly",
					},
				);
			}
			if (url === "https://timetreeapp.com/calendars") {
				return htmlResponse(200, htmlWithCsrf("tok"));
			}
			throw new Error(`unexpected ${url}`);
		};
		const client = new TimeTreeClient({
			profileName: "p",
			sessionFile: file,
			fetchImpl,
		});
		await client.createEvent("cal-1", { title: "予定" });
		const saved = JSON.parse(readFileSync(file, "utf8")) as {
			cookies: { name: string; value: string }[];
		};
		expect(saved.cookies).toContainEqual({ name: "_session_id", value: "sess-2" });
	});

	it("カレンダー一覧を正規化する", async () => {
		const fetchImpl: FetchLike = (url) => {
			if (url === "https://timetreeapp.com/api/v1/calendars?since=0") {
				return jsonResponse(200, {
					calendars: [
						{
							id: 1024420045,
							name: "プライベート",
							alias_code: "AB12",
							deactivated_at: null,
							calendar_labels: [
								{ id: 1, name: "学校" },
								{ id: 2, name: "バイト" },
							],
							calendar_users: [
								{ id: 42, user_id: 42, name: "太郎" },
								{ id: 43, user_id: 43, name: "花子" },
							],
						},
						{ id: "cal-2", name: "旧カレンダー", alias_code: null, deactivated_at: 1732086000000 },
					],
				});
			}
			throw new Error(`unexpected ${url}`);
		};
		const client = new TimeTreeClient({
			profileName: "p",
			sessionFile: sessionFileIn(),
			fetchImpl,
		});
		const calendars = await client.listCalendars();
		expect(calendars).toHaveLength(2);
		expect(calendars[0]?.id).toBe("1024420045");
		expect(calendars[0]?.labels).toEqual([
			{ id: 1, name: "学校" },
			{ id: 2, name: "バイト" },
		]);
		expect(calendars[0]?.members).toEqual([
			{ userId: 42, name: "太郎" },
			{ userId: 43, name: "花子" },
		]);
		expect(calendars[1]?.deactivatedAt).toBe(new Date(1732086000000).toISOString());
	});

	it("未知の応答形状はUPSTREAM_CHANGEDになる", async () => {
		const fetchImpl: FetchLike = (url) => {
			if (url === "https://timetreeapp.com/api/v1/user") return jsonResponse(200, { broken: true });
			throw new Error(`unexpected ${url}`);
		};
		const client = new TimeTreeClient({
			profileName: "p",
			sessionFile: sessionFileIn(),
			fetchImpl,
		});
		await expect(client.getCurrentUser()).rejects.toMatchObject({ code: "UPSTREAM_CHANGED" });
	});

	it("セッションファイルがなければlogin_requiredで始まる", () => {
		const client = new TimeTreeClient({
			profileName: "p",
			sessionFile: join(tempDir(), "missing.json"),
			fetchImpl: (async () => jsonResponse(200, {})) as FetchLike,
		});
		expect(client.state).toBe("login_required");
		expect(client.currentUser).toBeNull();
	});
});

describe("日時変換", () => {
	it("タイムゾーン付きの暦日時をエポックmsへ変換する", () => {
		expect(zonedToEpochMs(2026, 11, 20, 10, 0, 0, "Asia/Tokyo")).toBe(Date.parse("2026-11-20T10:00:00+09:00"));
		expect(zonedToEpochMs(2026, 11, 20, 1, 30, 0, "UTC")).toBe(Date.parse("2026-11-20T01:30:00Z"));
	});

	it("終日の日付をタイムゾーン先頭の0時へ変換する", () => {
		expect(boundaryToEpochMs({ date: "2026-11-20" }, "Asia/Tokyo")).toBe(Date.parse("2026-11-20T00:00:00+09:00"));
	});

	it("オフセット付き日時はそのまま解釈する", () => {
		expect(boundaryToEpochMs({ dateTime: "2026-11-20T10:00:00Z" }, "Asia/Tokyo")).toBe(
			Date.parse("2026-11-20T10:00:00Z"),
		);
		expect(boundaryToEpochMs({ dateTime: "2026-11-20T10:00:00+09:00" }, "Asia/Tokyo")).toBe(
			Date.parse("2026-11-20T10:00:00+09:00"),
		);
	});

	it("オフセットなし日時は既定タイムゾーンで解釈する", () => {
		expect(boundaryToEpochMs({ dateTime: "2026-11-20T10:00:00" }, "Asia/Tokyo")).toBe(
			Date.parse("2026-11-20T10:00:00+09:00"),
		);
	});

	it("不正なタイムゾーンはINVALID_INPUTになる", () => {
		expect(() => zonedToEpochMs(2026, 11, 20, 10, 0, 0, "存在しない/場所")).toThrowError(TimeTreeError);
	});
});
