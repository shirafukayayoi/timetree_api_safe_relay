import type {
	CreateEventInput,
	DeleteEventInput,
	UpdateEventTitleInput,
	EventJob,
	JobFailure,
	JobKind,
	RelayErrorCode,
} from "timetree-api-safe-contracts";
import type { RelayProfile, Logger } from "../types.js";
import type { SerialQueue } from "../utils/queue.js";
import { boundaryToEpochMs, type TimeTreeClient } from "../timetree/client.js";
import { isTimeTreeError, TimeTreeError } from "../timetree/errors.js";
import { EventJobStore, newJobId, requestHash } from "./store.js";

/** 終日予定の日付をTimeTreeの表現（当日の00:00 UTC）へ変換する。 */
const dateOnlyToUtcMidnight = (date: string): number => {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!match) throw new TimeTreeError("INVALID_INPUT", "日付は YYYY-MM-DD 形式で指定してください");
	const [, year, month, day] = match;
	return Date.UTC(Number(year), Number(month) - 1, Number(day));
};

export type EventServiceOptions = {
	stateDir: string;
	defaultTimezone: string;
	logger: Logger;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** 追加・削除ジョブの受付・検証・実行。公開要求の自動再送は行わない。 */
export class EventService {
	#store: EventJobStore;
	#defaultTimezone: string;
	#logger: Logger;

	constructor(options: EventServiceOptions) {
		this.#store = new EventJobStore(options.stateDir);
		this.#defaultTimezone = options.defaultTimezone;
		this.#logger = options.logger;
		this.#restoreInFlightJobs();
	}

	/** 再起動時の未確定ジョブ。作成・削除中は unknown、それ以前は failed にする。 */
	#restoreInFlightJobs(): void {
		for (const job of this.#store.all()) {
			if (job.state === "creating" || job.state === "deleting" || job.state === "updating") {
				this.#transition(job.id, "unknown", {
					failure: {
						code: "UNVERIFIED",
						message: "Relayの再起動で公開・削除要求の結果を確認できませんでした。TimeTree上で確認してください",
					},
				});
			} else if (job.state === "queued" || job.state === "validating") {
				this.#transition(job.id, "failed", {
					failure: {
						code: "INTERRUPTED",
						message: "Relayの再起動で処理が中断しました。自動再送は行いません",
					},
				});
			}
		}
	}

	getJob(id: string): EventJob | undefined {
		return this.#store.get(id);
	}

	#findByKey(
		profile: string,
		kind: JobKind,
		key: string,
		request: unknown,
	): { job: EventJob } | "conflict" | undefined {
		const found = this.#store.findByKey(profile, kind, key);
		if (!found) return undefined;
		if (found.hash !== requestHash(request)) return "conflict";
		return { job: found.job };
	}

	/** 追加ジョブを作る。同一キー同一要求は既存ジョブを返す。 */
	createJob(profile: RelayProfile, key: string, input: CreateEventInput): { job: EventJob; created: boolean } {
		const existing = this.#findByKey(profile.name, "create", key, input);
		if (existing === "conflict") {
			throw new TimeTreeError("IDEMPOTENCY_CONFLICT", "同じIdempotency-Keyで異なる要求が指定されました");
		}
		if (existing) return { job: existing.job, created: false };
		const now = new Date().toISOString();
		const job: EventJob = {
			id: newJobId(),
			kind: "create",
			state: "queued",
			profile: profile.name,
			key,
			request: input,
			eventId: null,
			failure: null,
			createdAt: now,
			updatedAt: now,
		};
		this.#store.save(job);
		return { job, created: true };
	}

	/** 削除ジョブを作る。同一キー同一要求は既存ジョブを返す。 */
	deleteJob(profile: RelayProfile, key: string, input: DeleteEventInput): { job: EventJob; created: boolean } {
		const existing = this.#findByKey(profile.name, "delete", key, input);
		if (existing === "conflict") {
			throw new TimeTreeError("IDEMPOTENCY_CONFLICT", "同じIdempotency-Keyで異なる要求が指定されました");
		}
		if (existing) return { job: existing.job, created: false };
		const now = new Date().toISOString();
		const job: EventJob = {
			id: newJobId(),
			kind: "delete",
			state: "queued",
			profile: profile.name,
			key,
			request: input,
			eventId: input.eventId,
			failure: null,
			createdAt: now,
			updatedAt: now,
		};
		this.#store.save(job);
		return { job, created: true };
	}

	/** タイトル変更ジョブを作る。同じキーでは再送しない。 */
	updateTitleJob(profile: RelayProfile, key: string, input: UpdateEventTitleInput): { job: EventJob; created: boolean } {
		const existing = this.#findByKey(profile.name, "updateTitle", key, input);
		if (existing === "conflict") throw new TimeTreeError("IDEMPOTENCY_CONFLICT", "同じキーで異なる要求が指定されました");
		if (existing) return { job: existing.job, created: false };
		const now = new Date().toISOString();
		const job: EventJob = { id: newJobId(), kind: "updateTitle", state: "queued", profile: profile.name, key,
			request: input, eventId: input.eventId, failure: null, createdAt: now, updatedAt: now };
		this.#store.save(job);
		return { job, created: true };
	}

	/** ジョブをプロファイルのキューへ投入する。処理は直列で実行される。 */
	enqueue(profile: RelayProfile, queue: SerialQueue, jobId: string): void {
		void queue
			.run(async () => {
				const job = this.#store.get(jobId);
				if (!job) return;
				if (job.kind === "create") await this.#runCreate(job, profile.client);
				else if (job.kind === "delete") await this.#runDelete(job, profile.client);
				else await this.#runUpdateTitle(job, profile.client);
			})
			.catch((error: unknown) => {
				this.#logger.error(`ジョブ ${jobId} の処理で予期しないエラー: ${String(error)}`);
				const job = this.#store.get(jobId);
				if (job?.state === "updating") {
					this.#markUnknown(jobId, "変更処理中に予期しないエラーが発生しました。TimeTree上で確認してください");
				} else if (job && (job.state === "queued" || job.state === "validating")) {
					this.#transition(jobId, "failed", {
						failure: { code: "UPSTREAM_CHANGED", message: "処理中に予期しないエラーが発生しました" },
					});
				}
			});
	}

	#transition(
		jobId: string,
		state: EventJob["state"],
		opts?: { eventId?: string | null; failure?: JobFailure | null },
	): void {
		const job = this.#store.get(jobId);
		if (!job) return;
		job.state = state;
		job.updatedAt = new Date().toISOString();
		if (opts?.eventId !== undefined) job.eventId = opts.eventId;
		if (opts?.failure !== undefined) job.failure = opts.failure;
		this.#store.save(job);
	}

	/** 失敗へ落着させる。 */
	#fail(jobId: string, error: unknown): void {
		const code: RelayErrorCode = isTimeTreeError(error) ? error.code : "UPSTREAM_CHANGED";
		const message = error instanceof Error ? error.message : "TimeTreeから予期しない応答を受け取りました";
		this.#transition(jobId, "failed", { failure: { code, message } });
	}

	/** 結果不明へ落着させる。公開・削除要求は再送しない。 */
	#markUnknown(jobId: string, message: string, eventId?: string | null): void {
		this.#transition(jobId, "unknown", {
			failure: { code: "UNVERIFIED", message },
			...(eventId === undefined ? {} : { eventId }),
		});
	}

	async #runCreate(job: EventJob, client: TimeTreeClient): Promise<void> {
		const input = job.request as CreateEventInput;
		this.#transition(job.id, "validating");
		try {
			if (client.state !== "ready") {
				// セッション状態が未確定なら一度だけ確認する。自動再ログインは行わない。
				await client.checkSession();
			}
			const timezone = input.timezone ?? this.#defaultTimezone;
			const allDay = input.allDay ?? "date" in input.start;
			let startMs: number;
			let endMs: number;
			/** 終日予定のタイムゾーン。TimeTreeは終日をUTCの0時で保存する。 */
			let payloadTimezone = timezone;
			if (allDay) {
				if (!("date" in input.start)) {
					throw new TimeTreeError("INVALID_INPUT", "終日予定には start を date 形式で指定してください");
				}
				// TimeTreeの終日表現: 開始=当日の00:00 UTC、単日は終了=開始、複数日は終了=最終日の翌日00:00 UTC。
				startMs = dateOnlyToUtcMidnight(input.start.date);
				if (input.end !== undefined) {
					if (!("date" in input.end)) {
						throw new TimeTreeError("INVALID_INPUT", "終日予定の end は date 形式で指定してください");
					}
					const exclusiveEnd = dateOnlyToUtcMidnight(input.end.date);
					endMs = exclusiveEnd - startMs > 86_400_000 ? exclusiveEnd : startMs;
				} else {
					endMs = startMs;
				}
				payloadTimezone = "UTC";
			} else {
				startMs = boundaryToEpochMs(input.start, timezone);
				if (input.end !== undefined) {
					endMs = boundaryToEpochMs(input.end, timezone);
				} else {
					throw new TimeTreeError("INVALID_INPUT", "時刻付きの予定には end を指定してください");
				}
			}
			const calendars = await client.listCalendars();
			if (!calendars.some((calendar) => calendar.id === input.calendarId)) {
				throw new TimeTreeError("NOT_FOUND", "指定されたカレンダーが見つかりません");
			}
			const attendees = input.attendees ?? (client.currentUser ? [client.currentUser.id] : []);
			const payload = {
				title: input.title,
				all_day: allDay,
				start_at: startMs,
				start_timezone: payloadTimezone,
				end_at: endMs,
				end_timezone: payloadTimezone,
				label_id: input.labelId ?? 1,
				note: input.note ?? "",
				location: input.location ?? "",
				attendees,
				recurrences: [],
				alerts: [],
				attachment: { virtual_user_attendees: [] },
				category: 1,
			};
			this.#transition(job.id, "creating");
			let createdId: string | null = null;
			try {
				const response = await client.createEvent(input.calendarId, payload);
				createdId = extractEventId(response);
			} catch (error) {
				if (isTimeTreeError(error) && error.code === "TRANSPORT_ERROR") {
					this.#markUnknown(job.id, "追加要求を送信しましたが結果を確認できませんでした。TimeTree上で確認してください");
					return;
				}
				throw error;
			}
			this.#transition(job.id, "creating", { eventId: createdId });
			try {
				const events = await client.listEvents(input.calendarId);
				const found = createdId ? events.find((event) => event.id === createdId) : undefined;
				if (found && found.title === input.title && Date.parse(found.startAt) === startMs) {
					this.#transition(job.id, "created", { eventId: createdId, failure: null });
					this.#logger.info(`予定を追加しました: ${createdId}`);
					return;
				}
				this.#markUnknown(
					job.id,
					"追加要求は受理されましたが、読み戻しで予定を確認できませんでした。TimeTree上で確認してください",
					createdId,
				);
			} catch (error) {
				this.#markUnknown(
					job.id,
					"追加要求は受理されましたが、読み戻しに失敗しました。TimeTree上で確認してください",
					createdId,
				);
				this.#logger.warn(`追加後の読み戻しに失敗: ${String(error)}`);
			}
		} catch (error) {
			this.#fail(job.id, error);
			this.#logger.warn(`追加ジョブ ${job.id} が失敗: ${String(error)}`);
		}
	}

	async #runUpdateTitle(job: EventJob, client: TimeTreeClient): Promise<void> {
		const input = job.request as UpdateEventTitleInput;
		this.#transition(job.id, "validating");
		try {
			if (client.state !== "ready") await client.checkSession();
			const before = (await client.listEvents(input.calendarId)).find((event) => event.id === input.eventId);
			if (!before) throw new TimeTreeError("NOT_FOUND", "変更対象の予定が見つかりません");
			if (before.recurring) throw new TimeTreeError("INVALID_INPUT", "繰り返し予定の変更には対応していません");
			if (before.title !== input.expectedTitle || before.updatedAt !== input.expectedUpdatedAt) {
				throw new TimeTreeError("IDEMPOTENCY_CONFLICT", "予定が変更されています。再取得して確認してください");
			}
			if (before.title === input.title) {
				this.#transition(job.id, "updated", { failure: null });
				return;
			}
			this.#transition(job.id, "updating");
			try {
				await client.updateEventTitle(input.calendarId, input.eventId, input.title);
				const after = (await client.listEvents(input.calendarId)).find((event) => event.id === input.eventId);
				if (!after) throw new Error("変更後の予定が見つかりません");
				const { title: _oldTitle, updatedAt: _oldUpdated, ...beforeOther } = before;
				const { title: _newTitle, updatedAt: _newUpdated, ...afterOther } = after;
				if (after.title !== input.title || JSON.stringify(beforeOther) !== JSON.stringify(afterOther)) {
					this.#markUnknown(job.id, "変更後のタイトルまたは他の項目を照合できません。TimeTree上で確認してください");
					return;
				}
				this.#transition(job.id, "updated", { failure: null });
			} catch {
				this.#markUnknown(job.id, "変更要求後の結果を確認できません。TimeTree上で確認し、再送しないでください");
			}
		} catch (error) {
			this.#fail(job.id, error);
		}
	}

	async #runDelete(job: EventJob, client: TimeTreeClient): Promise<void> {
		const input = job.request as DeleteEventInput;
		this.#transition(job.id, "validating");
		try {
			if (client.state !== "ready") {
				// セッション状態が未確定なら一度だけ確認する。自動再ログインは行わない。
				await client.checkSession();
			}
			const events = await client.listEvents(input.calendarId);
			const target = events.find((event) => event.id === input.eventId);
			if (!target) {
				throw new TimeTreeError("NOT_FOUND", "削除対象の予定が見つかりません");
			}
			if (target.recurring && input.allowSeries !== true) {
				throw new TimeTreeError(
					"SERIES_DELETE_REQUIRED",
					"繰り返し予定です。系列全体を削除するには allowSeries: true が必要です",
				);
			}
			this.#transition(job.id, "deleting");
			try {
				await client.deleteEvent(input.calendarId, input.eventId);
			} catch (error) {
				if (isTimeTreeError(error) && error.code === "TRANSPORT_ERROR") {
					this.#markUnknown(job.id, "削除要求を送信しましたが結果を確認できませんでした。TimeTree上で確認してください");
					return;
				}
				throw error;
			}
			try {
				const after = await client.listEvents(input.calendarId);
				if (after.some((event) => event.id === input.eventId)) {
					this.#markUnknown(job.id, "削除要求は受理されましたが、予定がまだ存在します。TimeTree上で確認してください");
					return;
				}
				this.#transition(job.id, "deleted", { failure: null });
				this.#logger.info(`予定を削除しました: ${input.eventId}`);
			} catch (error) {
				this.#markUnknown(job.id, "削除要求は受理されましたが、消失確認に失敗しました。TimeTree上で確認してください");
				this.#logger.warn(`削除後の消失確認に失敗: ${String(error)}`);
			}
		} catch (error) {
			this.#fail(job.id, error);
			this.#logger.warn(`削除ジョブ ${job.id} が失敗: ${String(error)}`);
		}
	}
}

/** 追加応答から作成済み予定のIDを取り出す。形状が不明でも要求は受理済みのため unknown 扱いにする。 */
const extractEventId = (response: unknown): string | null => {
	const candidates: unknown[] = [];
	if (isRecord(response)) {
		candidates.push(response.event, response.data, response);
	}
	for (const candidate of candidates) {
		if (!isRecord(candidate)) continue;
		const id =
			typeof candidate.uuid === "string" ? candidate.uuid : typeof candidate.id === "string" ? candidate.id : null;
		if (id) return id;
	}
	return null;
};
