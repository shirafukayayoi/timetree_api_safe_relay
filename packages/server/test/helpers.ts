import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CurrentUser, TimeTreeEvent } from "timetree-api-safe-contracts";
import type { ProfileState, TimeTreeClient } from "../src/timetree/client.js";

/** 条件が成立するまで短い間隔で待つ。 */
export const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("条件が時間内に成立しませんでした");
};

/** テスト用の一時ディレクトリを作る。 */
export const tempDir = (): string => mkdtempSync(join(tmpdir(), "timetree-relay-test-"));

export const noopLogger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

export const jsonResponse = (status: number, body: unknown, headers?: Record<string, string>) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

export const htmlResponse = (status: number, html: string) =>
	new Response(html, { status, headers: { "content-type": "text/html" } });

export const htmlWithCsrf = (token: string) =>
	`<html><head><meta name="csrf-token" content="${token}"></head><body></body></html>`;

export type FakeClientOptions = {
	calendarId?: string;
	events?: TimeTreeEvent[];
	createdEventId?: string;
	createError?: Error;
	deleteError?: Error;
	user?: CurrentUser;
	state?: ProfileState;
};

/** ジョブ処理に必要なTimeTreeClientの操作だけを模倣するクライアント。 */
export const makeFakeClient = (options: FakeClientOptions = {}) => {
	const calendarId = options.calendarId ?? "cal-1";
	const events: TimeTreeEvent[] = [...(options.events ?? [])];
	const client = {
		state: options.state ?? "ready",
		currentUser: options.user ?? { id: 42, name: "太郎", email: null },
		async checkSession() {
			return client.currentUser;
		},
		async listCalendars() {
			return [
				{
					id: calendarId,
					name: "プライベート",
					aliasCode: null,
					deactivatedAt: null,
					labels: [{ id: 1, name: "その他" }],
				},
			];
		},
		async listEvents() {
			return [...events];
		},
		async createEvent(_targetCalendarId: string, payload: Record<string, unknown>) {
			if (options.createError) throw options.createError;
			const event: TimeTreeEvent = {
				id: options.createdEventId ?? "ev-created",
				title: String(payload.title),
				allDay: payload.all_day === true,
				startAt: new Date(Number(payload.start_at)).toISOString(),
				endAt: new Date(Number(payload.end_at)).toISOString(),
				timezone: String(payload.start_timezone),
				note: null,
				location: null,
				labelId: 1,
				attendees: [],
				recurring: false,
				category: 1,
				url: null,
				updatedAt: null,
			};
			events.push(event);
			return { event: { uuid: event.id } };
		},
		async deleteEvent(_targetCalendarId: string, eventId: string) {
			if (options.deleteError) throw options.deleteError;
			const index = events.findIndex((event) => event.id === eventId);
			if (index >= 0) events.splice(index, 1);
		},
	};
	return client as unknown as TimeTreeClient;
};

export const makeEvent = (overrides: Partial<TimeTreeEvent> = {}): TimeTreeEvent => ({
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
	...overrides,
});
