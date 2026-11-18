import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AccountService } from "../src/accounts/service.js";
import { EventService } from "../src/events/service.js";
import type { RelayProfile } from "../src/types.js";
import { makeEvent, makeFakeClient, noopLogger, tempDir, waitFor } from "./helpers.js";

const token = "test-token-1234567890";

const buildApp = (options?: { profiles?: RelayProfile[] }) => {
	const profiles =
		options?.profiles ??
		([
			{
				name: "account1",
				client: makeFakeClient(),
			},
		] satisfies RelayProfile[]);
	const accounts = new AccountService({
		profiles,
		selectionFile: `${tempDir()}/selected-account.json`,
		logger: noopLogger,
	});
	const events = new EventService({
		stateDir: tempDir(),
		defaultTimezone: "Asia/Tokyo",
		logger: noopLogger,
	});
	const app = createApp({ profiles, token, accounts, events });
	return { app, events, profiles };
};

const authorizedHeaders = (extra: Record<string, string> = {}) => ({
	authorization: `Bearer ${token}`,
	host: "127.0.0.1:3100",
	...extra,
});

describe("createApp 認証とヘッダー", () => {
	it("Bearerトークンなしでは401", async () => {
		const { app } = buildApp();
		const response = await app.request("/v1/calendars", {
			headers: { host: "127.0.0.1:3100" },
		});
		expect(response.status).toBe(401);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("/healthは認証なしで利用できる", async () => {
		const { app } = buildApp();
		const response = await app.request("/health", { headers: { host: "127.0.0.1:3100" } });
		expect(response.status).toBe(200);
	});

	it("存在しないパスは404", async () => {
		const { app } = buildApp();
		const response = await app.request("/v1/nothing", { headers: authorizedHeaders() });
		expect(response.status).toBe(404);
	});
});

describe("createApp カレンダー・予定一覧", () => {
	it("カレンダー一覧を返す", async () => {
		const { app } = buildApp();
		const response = await app.request("/v1/calendars", { headers: authorizedHeaders() });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: { items: { id: string; name: string }[] } };
		expect(body.data.items[0]?.id).toBe("cal-1");
	});

	it("予定一覧を範囲でフィルターする", async () => {
		const { app } = buildApp();
		const response = await app.request(
			"/v1/events?calendarId=cal-1&from=2026-11-01T00:00:00Z&to=2026-11-30T23:59:59Z",
			{ headers: authorizedHeaders() },
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: { items: unknown[] } };
		expect(Array.isArray(body.data.items)).toBe(true);
	});

	it("期間一覧は過去開始の毎週系列を各回に展開する", async () => {
		const { app } = buildApp({
			profiles: [
				{
					name: "account1",
					client: makeFakeClient({
						events: [
							makeEvent({
								recurring: true,
								startAt: "2026-11-11T10:30:00.000Z",
								endAt: "2026-11-11T11:45:00.000Z",
								recurrenceRules: ["RRULE:FREQ=WEEKLY", "EXDATE:20261125T103000Z"],
							}),
						],
					}),
				},
			],
		});
		const response = await app.request(
			"/v1/events?calendarId=cal-1&from=2026-11-18T00:00:00Z&to=2026-11-30T23:59:59Z",
			{ headers: authorizedHeaders() },
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: { items: { startAt: string; seriesId: string; id: string }[] } };
		expect(body.data.items).toHaveLength(1);
		expect(body.data.items[0]?.startAt).toBe("2026-11-18T10:30:00.000Z");
		expect(body.data.items[0]?.seriesId).toBe("ev-1");
		expect(body.data.items[0]?.id).not.toBe("ev-1");
	});

	it("逆転期間では400を返す", async () => {
		const { app } = buildApp();
		const response = await app.request(
			"/v1/events?calendarId=cal-1&from=2026-11-30T00:00:00Z&to=2026-11-01T00:00:00Z",
			{ headers: authorizedHeaders() },
		);
		expect(response.status).toBe(400);
	});

	it("calendarIdなしでは400", async () => {
		const { app } = buildApp();
		const response = await app.request("/v1/events", { headers: authorizedHeaders() });
		expect(response.status).toBe(400);
	});
});

describe("createApp 追加・削除ジョブ", () => {
	it("Idempotency-Keyなしでは400", async () => {
		const { app } = buildApp();
		const response = await app.request("/v1/events", {
			method: "POST",
			headers: authorizedHeaders({ "content-type": "application/json" }),
			body: JSON.stringify({ calendarId: "cal-1", title: "予定", start: { date: "2026-11-20" } }),
		});
		expect(response.status).toBe(400);
	});

	it("追加ジョブを202で受け付け、createdまで進む", async () => {
		const { app, events } = buildApp();
		const response = await app.request("/v1/events", {
			method: "POST",
			headers: authorizedHeaders({ "content-type": "application/json", "Idempotency-Key": "key-1" }),
			body: JSON.stringify({
				calendarId: "cal-1",
				title: "歯科検診",
				allDay: false,
				start: { dateTime: "2026-11-20T10:00:00+09:00" },
				end: { dateTime: "2026-11-20T11:00:00+09:00" },
			}),
		});
		expect(response.status).toBe(202);
		const body = (await response.json()) as { data: { id: string; state: string } };
		expect(body.data.state).toBe("queued");
		await waitFor(() => events.getJob(body.data.id)?.state === "created");
		const jobResponse = await app.request(`/v1/event-jobs/${body.data.id}`, {
			headers: authorizedHeaders(),
		});
		const job = ((await jobResponse.json()) as { data: { state: string; eventId: string } }).data;
		expect(job.state).toBe("created");
		expect(job.eventId).toBe("ev-created");
	});

	it("同じキーで同じ要求は既存ジョブを200で返す", async () => {
		const { app } = buildApp();
		const payload = JSON.stringify({
			calendarId: "cal-1",
			title: "歯科検診",
			allDay: true,
			start: { date: "2026-11-20" },
		});
		const headers = authorizedHeaders({ "content-type": "application/json", "Idempotency-Key": "same-1" });
		const first = await app.request("/v1/events", { method: "POST", headers, body: payload });
		const second = await app.request("/v1/events", { method: "POST", headers, body: payload });
		expect(first.status).toBe(202);
		expect(second.status).toBe(200);
		const firstBody = (await first.json()) as { data: { id: string } };
		const secondBody = (await second.json()) as { data: { id: string } };
		expect(secondBody.data.id).toBe(firstBody.data.id);
	});

	it("同じキーで異なる要求は409", async () => {
		const { app } = buildApp();
		const headers = authorizedHeaders({ "content-type": "application/json", "Idempotency-Key": "conf-1" });
		await app.request("/v1/events", {
			method: "POST",
			headers,
			body: JSON.stringify({ calendarId: "cal-1", title: "A", start: { date: "2026-11-20" } }),
		});
		const response = await app.request("/v1/events", {
			method: "POST",
			headers,
			body: JSON.stringify({ calendarId: "cal-1", title: "B", start: { date: "2026-11-20" } }),
		});
		expect(response.status).toBe(409);
	});

	it("削除ジョブを受け付けてdeletedまで進む", async () => {
		const { app, events } = buildApp({
			profiles: [
				{
					name: "account1",
					client: makeFakeClient({
						events: [
							{
								id: "ev-1",
								title: "テスト予定",
								allDay: false,
								startAt: "2026-11-20T01:00:00.000Z",
								endAt: "2026-11-20T02:00:00.000Z",
								timezone: "Asia/Tokyo",
								note: null,
								location: null,
								labelId: 1,
								attendees: [42],
								recurring: false,
								category: 1,
								url: null,
								updatedAt: null,
							},
						],
					}),
				},
			],
		});
		const response = await app.request("/v1/events/delete", {
			method: "POST",
			headers: authorizedHeaders({ "content-type": "application/json", "Idempotency-Key": "del-1" }),
			body: JSON.stringify({ calendarId: "cal-1", eventId: "ev-1" }),
		});
		expect(response.status).toBe(202);
		const body = (await response.json()) as { data: { id: string } };
		await waitFor(() => events.getJob(body.data.id)?.state === "deleted");
	});

	it("存在しないジョブの照会は404", async () => {
		const { app } = buildApp();
		const response = await app.request("/v1/event-jobs/unknown-id", { headers: authorizedHeaders() });
		expect(response.status).toBe(404);
	});
});

describe("createApp アカウント", () => {
	it("アカウント一覧と選択を返す", async () => {
		const { app } = buildApp();
		const response = await app.request("/v1/accounts", { headers: authorizedHeaders() });
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			data: { accounts: { profile: string; state: string }[]; selected: unknown };
		};
		expect(body.data.accounts[0]?.profile).toBe("account1");
		expect(body.data.selected).toBeNull();
	});

	it("expectedAccountIdが一致すれば選択できる", async () => {
		const { app } = buildApp();
		const response = await app.request("/v1/accounts/select", {
			method: "POST",
			headers: authorizedHeaders({ "content-type": "application/json" }),
			body: JSON.stringify({ profile: "account1", expectedAccountId: 42 }),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: { profile: string; accountId: number } };
		expect(body.data.profile).toBe("account1");
		expect(body.data.accountId).toBe(42);
	});

	it("expectedAccountIdが不一致なら400", async () => {
		const { app } = buildApp();
		const response = await app.request("/v1/accounts/select", {
			method: "POST",
			headers: authorizedHeaders({ "content-type": "application/json" }),
			body: JSON.stringify({ profile: "account1", expectedAccountId: 999 }),
		});
		expect(response.status).toBe(400);
	});

	it("未登録プロファイルの選択は400", async () => {
		const { app } = buildApp();
		const response = await app.request("/v1/accounts/select", {
			method: "POST",
			headers: authorizedHeaders({ "content-type": "application/json" }),
			body: JSON.stringify({ profile: "nobody" }),
		});
		expect(response.status).toBe(400);
	});
});

describe("createApp 複数プロファイル", () => {
	it("x-profile-nameなしでは400", async () => {
		const { app } = buildApp({
			profiles: [
				{ name: "account1", client: makeFakeClient() },
				{ name: "account2", client: makeFakeClient() },
			],
		});
		const response = await app.request("/v1/calendars", { headers: authorizedHeaders() });
		expect(response.status).toBe(400);
	});

	it("x-profile-nameでプロファイルを選べる", async () => {
		const { app } = buildApp({
			profiles: [
				{ name: "account1", client: makeFakeClient() },
				{ name: "account2", client: makeFakeClient({ calendarId: "cal-2" }) },
			],
		});
		const response = await app.request("/v1/calendars", {
			headers: authorizedHeaders({ "x-profile-name": "account2" }),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: { items: { id: string }[] } };
		expect(body.data.items[0]?.id).toBe("cal-2");
	});
});
