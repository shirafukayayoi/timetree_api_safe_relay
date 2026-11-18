import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
	type CreateEventInput,
	type DeleteEventInput,
	type UpdateEventTitleInput,
	type EventJob,
	type ListEventsInput,
	idempotencyKeySchema,
	parseOperationInput,
} from "timetree-api-safe-contracts";
import type { RelayProfile } from "../types.js";
import type { EventService } from "./service.js";
import type { SerialQueue } from "../utils/queue.js";
import { fail } from "../utils/errors.js";
import { eventsInRange } from "./recurrence.js";

export type MountEventRoutesOptions = {
	app: Hono;
	service: EventService;
	queues: Map<string, SerialQueue>;
	resolveProfile: (header: string | undefined) => RelayProfile | undefined;
};

const readKey = (raw: string | undefined): string => (typeof raw === "string" ? raw.trim() : "");

export const mountEventRoutes = ({ app, service, queues, resolveProfile }: MountEventRoutesOptions): void => {
	app.use(
		"/v1/events*",
		bodyLimit({
			maxSize: 8192,
			onError: (c) =>
				c.json({ error: { code: "INVALID_INPUT", message: "要求のJSONは8KiB以下で指定してください" } }, 413),
		}),
	);

	app.get("/v1/calendars", async (c) => {
		const profile = resolveProfile(c.req.header("x-profile-name"));
		if (!profile) return fail(c, { code: "UNKNOWN_PROFILE", message: "プロファイルを特定できません" });
		const queue = queues.get(profile.name);
		if (!queue) return fail(c, { code: "UNKNOWN_PROFILE", message: "プロファイルを特定できません" });
		try {
			const calendars = await queue.run(() => profile.client.listCalendars());
			return c.json({ data: { items: calendars.filter((calendar) => calendar.deactivatedAt === null) } });
		} catch (error) {
			return fail(c, error);
		}
	});

	app.get("/v1/events", async (c) => {
		const profile = resolveProfile(c.req.header("x-profile-name"));
		if (!profile) return fail(c, { code: "UNKNOWN_PROFILE", message: "プロファイルを特定できません" });
		const queue = queues.get(profile.name);
		if (!queue) return fail(c, { code: "UNKNOWN_PROFILE", message: "プロファイルを特定できません" });
		const query = c.req.query();
		let input: ListEventsInput;
		try {
			input = parseOperationInput("listEvents", {
				calendarId: query.calendarId,
				from: query.from,
				to: query.to,
			});
		} catch (error) {
			return fail(c, error);
		}
		try {
			const events = await queue.run(() => profile.client.listEvents(input.calendarId));
			const filtered = eventsInRange(events, input.from, input.to);
			return c.json({ data: { items: filtered } });
		} catch (error) {
			return fail(c, error);
		}
	});

	app.post("/v1/events", async (c) => {
		const profile = resolveProfile(c.req.header("x-profile-name"));
		if (!profile) return fail(c, { code: "UNKNOWN_PROFILE", message: "プロファイルを特定できません" });
		const queue = queues.get(profile.name);
		if (!queue) return fail(c, { code: "UNKNOWN_PROFILE", message: "プロファイルを特定できません" });
		const key = readKey(c.req.header("Idempotency-Key"));
		const keyResult = idempotencyKeySchema.safeParse(key);
		if (!keyResult.success) {
			return fail(c, {
				code: "INVALID_INPUT",
				message: "Idempotency-Key ヘッダーを1〜128文字の英数字と ._:- で指定してください",
			});
		}
		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			return fail(c, { code: "INVALID_INPUT", message: "JSON本文を解析できません" });
		}
		let input: CreateEventInput;
		try {
			input = parseOperationInput("createEvent", raw);
		} catch (error) {
			return fail(c, error);
		}
		let created: { job: EventJob; created: boolean };
		try {
			created = service.createJob(profile, keyResult.data, input);
		} catch (error) {
			return fail(c, error);
		}
		if (created.created) service.enqueue(profile, queue, created.job.id);
		return c.json({ data: created.job }, created.created ? 202 : 200);
	});

	app.post("/v1/events/update-title", async (c) => {
		const profile = resolveProfile(c.req.header("x-profile-name"));
		if (!profile) return fail(c, { code: "UNKNOWN_PROFILE", message: "プロファイルを特定できません" });
		const queue = queues.get(profile.name);
		if (!queue) return fail(c, { code: "UNKNOWN_PROFILE", message: "プロファイルを特定できません" });
		const keyResult = idempotencyKeySchema.safeParse(readKey(c.req.header("Idempotency-Key")));
		if (!keyResult.success) return fail(c, { code: "INVALID_INPUT", message: "Idempotency-Keyが不正です" });
		let input: UpdateEventTitleInput;
		try {
			input = parseOperationInput("updateEventTitle", await c.req.json());
		} catch (error) { return fail(c, error); }
		try {
			const result = service.updateTitleJob(profile, keyResult.data, input);
			if (result.created) service.enqueue(profile, queue, result.job.id);
			return c.json({ data: result.job }, result.created ? 202 : 200);
		} catch (error) { return fail(c, error); }
	});

	app.post("/v1/events/delete", async (c) => {
		const profile = resolveProfile(c.req.header("x-profile-name"));
		if (!profile) return fail(c, { code: "UNKNOWN_PROFILE", message: "プロファイルを特定できません" });
		const queue = queues.get(profile.name);
		if (!queue) return fail(c, { code: "UNKNOWN_PROFILE", message: "プロファイルを特定できません" });
		const key = readKey(c.req.header("Idempotency-Key"));
		const keyResult = idempotencyKeySchema.safeParse(key);
		if (!keyResult.success) {
			return fail(c, {
				code: "INVALID_INPUT",
				message: "Idempotency-Key ヘッダーを1〜128文字の英数字と ._:- で指定してください",
			});
		}
		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			return fail(c, { code: "INVALID_INPUT", message: "JSON本文を解析できません" });
		}
		let input: DeleteEventInput;
		try {
			input = parseOperationInput("deleteEvent", raw);
		} catch (error) {
			return fail(c, error);
		}
		let created: { job: EventJob; created: boolean };
		try {
			created = service.deleteJob(profile, keyResult.data, input);
		} catch (error) {
			return fail(c, error);
		}
		if (created.created) service.enqueue(profile, queue, created.job.id);
		return c.json({ data: created.job }, created.created ? 202 : 200);
	});

	app.get("/v1/event-jobs/:id", (c) => {
		const job = service.getJob(c.req.param("id"));
		if (!job) return fail(c, { code: "NOT_FOUND", message: "指定されたジョブが見つかりません" });
		return c.json({ data: job });
	});
};
