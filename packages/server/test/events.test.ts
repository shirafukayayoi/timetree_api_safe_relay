import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EventJob } from "timetree-api-safe-contracts";
import { EventService } from "../src/events/service.js";
import { TimeTreeError } from "../src/timetree/errors.js";
import { SerialQueue } from "../src/utils/queue.js";
import type { RelayProfile } from "../src/types.js";
import { makeEvent, makeFakeClient, noopLogger, tempDir, waitFor } from "./helpers.js";

const profileOf = (client: RelayProfile["client"]): RelayProfile => ({
	name: "account1",
	client,
});

const createInput = {
	calendarId: "cal-1",
	title: "歯科検診",
	allDay: false,
	start: { dateTime: "2026-11-20T10:00:00+09:00" },
	end: { dateTime: "2026-11-20T11:00:00+09:00" },
	timezone: "Asia/Tokyo",
};

const serviceIn = (stateDir: string) =>
	new EventService({ stateDir, defaultTimezone: "Asia/Tokyo", logger: noopLogger });

const enqueueAndWait = async (service: EventService, profile: RelayProfile, jobId: string): Promise<EventJob> => {
	service.enqueue(profile, new SerialQueue(), jobId);
	await waitFor(() => {
		const state = service.getJob(jobId)?.state;
		return state !== undefined && !["queued", "validating", "creating", "deleting"].includes(state);
	});
	const job = service.getJob(jobId);
	if (!job) throw new Error("ジョブが見つかりません");
	return job;
};

describe("EventService 追加ジョブ", () => {
	it("追加して読み戻しで検証できたらcreatedになる", async () => {
		const service = serviceIn(tempDir());
		const profile = profileOf(makeFakeClient());
		const { job } = service.createJob(profile, "key-1", createInput);
		expect(job.state).toBe("queued");
		const finished = await enqueueAndWait(service, profile, job.id);
		expect(finished.state).toBe("created");
		expect(finished.eventId).toBe("ev-created");
		expect(finished.failure).toBeNull();
	});

	it("応答からイベントIDを読めない場合はunknownになる", async () => {
		const service = serviceIn(tempDir());
		const client = makeFakeClient({ createdEventId: "ev-x" });
		// 応答形状をIDなしにするため、作成だけ模倣を差し替える
		const broken = client as unknown as {
			createEvent: (calendarId: string, payload: Record<string, unknown>) => Promise<unknown>;
		};
		broken.createEvent = async () => ({ status: "ok" });
		const profile = profileOf(client);
		const { job } = service.createJob(profile, "key-1", createInput);
		const finished = await enqueueAndWait(service, profile, job.id);
		expect(finished.state).toBe("unknown");
		expect(finished.eventId).toBeNull();
		expect(finished.failure?.code).toBe("UNVERIFIED");
	});

	it("追加要求の通信が結果不明ならunknownにして再送しない", async () => {
		const service = serviceIn(tempDir());
		const client = makeFakeClient({
			createError: new TimeTreeError("TRANSPORT_ERROR", "接続が切断されました"),
		});
		const profile = profileOf(client);
		const { job } = service.createJob(profile, "key-1", createInput);
		const finished = await enqueueAndWait(service, profile, job.id);
		expect(finished.state).toBe("unknown");
	});

	it("明確な拒否はfailedになる", async () => {
		const service = serviceIn(tempDir());
		const client = makeFakeClient({
			createError: new TimeTreeError("SESSION_NOT_READY", "TimeTreeのセッションが失効しています"),
		});
		const profile = profileOf(client);
		const { job } = service.createJob(profile, "key-1", createInput);
		const finished = await enqueueAndWait(service, profile, job.id);
		expect(finished.state).toBe("failed");
		expect(finished.failure?.code).toBe("SESSION_NOT_READY");
	});

	it("存在しないカレンダーはfailed/NOT_FOUNDになる", async () => {
		const service = serviceIn(tempDir());
		const profile = profileOf(makeFakeClient({ calendarId: "cal-other" }));
		const { job } = service.createJob(profile, "key-1", createInput);
		const finished = await enqueueAndWait(service, profile, job.id);
		expect(finished.state).toBe("failed");
		expect(finished.failure?.code).toBe("NOT_FOUND");
	});

	it("時刻付きでendがない入力はfailed/INVALID_INPUTになる", async () => {
		const service = serviceIn(tempDir());
		const profile = profileOf(makeFakeClient());
		const { job } = service.createJob(profile, "key-1", {
			calendarId: "cal-1",
			title: "歯科検診",
			start: { dateTime: "2026-11-20T10:00:00+09:00" },
		});
		const finished = await enqueueAndWait(service, profile, job.id);
		expect(finished.state).toBe("failed");
		expect(finished.failure?.code).toBe("INVALID_INPUT");
	});

	it("終日予定はendなしで、UTCの0時として追加できる", async () => {
		const service = serviceIn(tempDir());
		const client = makeFakeClient();
		const profile = profileOf(client);
		const { job } = service.createJob(profile, "key-1", {
			calendarId: "cal-1",
			title: "旅行",
			allDay: true,
			start: { date: "2026-11-20" },
			timezone: "Asia/Tokyo",
		});
		const finished = await enqueueAndWait(service, profile, job.id);
		expect(finished.state).toBe("created");
		const payload = (client as unknown as { lastCreatePayload: Record<string, unknown> }).lastCreatePayload;
		expect(payload.start_at).toBe(Date.UTC(2026, 10, 20));
		expect(payload.end_at).toBe(Date.UTC(2026, 10, 20));
		expect(payload.start_timezone).toBe("UTC");
		expect(payload.end_timezone).toBe("UTC");
	});

	it("終日予定のendは最終日の翌日（複数日）または開始日と同日（単日）に正規化する", async () => {
		const service = serviceIn(tempDir());
		const client = makeFakeClient();
		const profile = profileOf(client);
		// Google形式の排他的終了日 12/5〜12/6 は単日 12/5 になる
		const single = service.createJob(profile, "key-single", {
			calendarId: "cal-1",
			title: "検定",
			allDay: true,
			start: { date: "2026-12-05" },
			end: { date: "2026-12-06" },
		});
		await enqueueAndWait(service, profile, single.job.id);
		let payload = (client as unknown as { lastCreatePayload: Record<string, unknown> }).lastCreatePayload;
		expect(payload.start_at).toBe(Date.UTC(2026, 11, 5));
		expect(payload.end_at).toBe(Date.UTC(2026, 11, 5));
		// 3日分（12/5〜12/8排他的）は終了が12/7になる
		const multi = service.createJob(profile, "key-multi", {
			calendarId: "cal-1",
			title: "卒業旅行",
			allDay: true,
			start: { date: "2026-12-05" },
			end: { date: "2026-12-08" },
		});
		await enqueueAndWait(service, profile, multi.job.id);
		payload = (client as unknown as { lastCreatePayload: Record<string, unknown> }).lastCreatePayload;
		expect(payload.start_at).toBe(Date.UTC(2026, 11, 5));
		expect(payload.end_at).toBe(Date.UTC(2026, 11, 8));
		expect(multi.job.state !== "queued").toBe(true);
	});

	it("指定したラベルと出席者で追加する", async () => {
		const service = serviceIn(tempDir());
		const client = makeFakeClient();
		const profile = profileOf(client);
		const { job } = service.createJob(profile, "key-label", {
			calendarId: "cal-1",
			title: "バイト",
			allDay: false,
			start: { dateTime: "2026-11-20T17:00:00+09:00" },
			end: { dateTime: "2026-11-20T21:00:00+09:00" },
			labelId: 4,
			attendees: [42, 43],
		});
		const finished = await enqueueAndWait(service, profile, job.id);
		expect(finished.state).toBe("created");
		const payload = (client as unknown as { lastCreatePayload: Record<string, unknown> }).lastCreatePayload;
		expect(payload.label_id).toBe(4);
		expect(payload.attendees).toEqual([42, 43]);
	});
});

describe("EventService 削除ジョブ", () => {
	it("削除して消失を確認したらdeletedになる", async () => {
		const service = serviceIn(tempDir());
		const client = makeFakeClient({ events: [makeEvent()] });
		const profile = profileOf(client);
		const { job } = service.deleteJob(profile, "del-1", {
			calendarId: "cal-1",
			eventId: "ev-1",
		});
		const finished = await enqueueAndWait(service, profile, job.id);
		expect(finished.state).toBe("deleted");
	});

	it("繰り返し予定はallowSeriesなしではfailed/SERIES_DELETE_REQUIREDになる", async () => {
		const service = serviceIn(tempDir());
		const client = makeFakeClient({ events: [makeEvent({ recurring: true })] });
		const profile = profileOf(client);
		const { job } = service.deleteJob(profile, "del-1", {
			calendarId: "cal-1",
			eventId: "ev-1",
		});
		const finished = await enqueueAndWait(service, profile, job.id);
		expect(finished.state).toBe("failed");
		expect(finished.failure?.code).toBe("SERIES_DELETE_REQUIRED");
	});

	it("繰り返し予定もallowSeries:trueなら削除できる", async () => {
		const service = serviceIn(tempDir());
		const client = makeFakeClient({ events: [makeEvent({ recurring: true })] });
		const profile = profileOf(client);
		const { job } = service.deleteJob(profile, "del-1", {
			calendarId: "cal-1",
			eventId: "ev-1",
			allowSeries: true,
		});
		const finished = await enqueueAndWait(service, profile, job.id);
		expect(finished.state).toBe("deleted");
	});

	it("存在しない予定はfailed/NOT_FOUNDになる", async () => {
		const service = serviceIn(tempDir());
		const profile = profileOf(makeFakeClient({ events: [] }));
		const { job } = service.deleteJob(profile, "del-1", {
			calendarId: "cal-1",
			eventId: "ev-404",
		});
		const finished = await enqueueAndWait(service, profile, job.id);
		expect(finished.state).toBe("failed");
		expect(finished.failure?.code).toBe("NOT_FOUND");
	});
});

describe("EventService 冪等と復帰", () => {
	it("同じキー同じ要求は既存ジョブを返す", () => {
		const service = serviceIn(tempDir());
		const profile = profileOf(makeFakeClient());
		const first = service.createJob(profile, "key-1", createInput);
		const second = service.createJob(profile, "key-1", createInput);
		expect(second.created).toBe(false);
		expect(second.job.id).toBe(first.job.id);
	});

	it("同じキーで異なる要求はIDEMPOTENCY_CONFLICTになる", () => {
		const service = serviceIn(tempDir());
		const profile = profileOf(makeFakeClient());
		service.createJob(profile, "key-1", createInput);
		expect(() => service.createJob(profile, "key-1", { ...createInput, title: "別の予定" })).toThrowError(
			expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }),
		);
	});

	it("ジョブ台帳を再読み込みしても既存ジョブと冪等キーを保持する", () => {
		const stateDir = tempDir();
		const profile = profileOf(makeFakeClient());
		const first = serviceIn(stateDir);
		const { job } = first.createJob(profile, "key-1", createInput);
		const second = serviceIn(stateDir);
		const found = second.createJob(profile, "key-1", createInput);
		expect(found.created).toBe(false);
		expect(found.job.id).toBe(job.id);
		expect(second.getJob(job.id)?.key).toBe("key-1");
	});

	it("再起動時の作成中ジョブはunknown、待機中ジョブはfailedになる", () => {
		const stateDir = tempDir();
		const now = new Date().toISOString();
		const creatingJob: EventJob = {
			id: "00000000-0000-4000-8000-000000000001",
			kind: "create",
			state: "creating",
			profile: "account1",
			key: "k-1",
			request: createInput,
			eventId: null,
			failure: null,
			createdAt: now,
			updatedAt: now,
		};
		const queuedJob: EventJob = {
			id: "00000000-0000-4000-8000-000000000002",
			kind: "delete",
			state: "queued",
			profile: "account1",
			key: "k-2",
			request: { calendarId: "cal-1", eventId: "ev-1" },
			eventId: "ev-1",
			failure: null,
			createdAt: now,
			updatedAt: now,
		};
		writeFileSync(join(stateDir, `${creatingJob.id}.json`), JSON.stringify(creatingJob), "utf8");
		writeFileSync(join(stateDir, `${queuedJob.id}.json`), JSON.stringify(queuedJob), "utf8");
		const service = serviceIn(stateDir);
		expect(service.getJob(creatingJob.id)?.state).toBe("unknown");
		expect(service.getJob(queuedJob.id)?.state).toBe("failed");
		expect(service.getJob(queuedJob.id)?.failure?.code).toBe("INTERRUPTED");
	});
});
