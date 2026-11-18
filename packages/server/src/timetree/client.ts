import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Calendar, CurrentUser, EventBoundary, TimeTreeEvent } from "timetree-api-safe-contracts";
import { TimeTreeError } from "./errors.js";

const WEB_BASE = "https://timetreeapp.com";
const API_BASE = "https://timetreeapp.com/api/v1";
/** TimeTree Web クライアントと同じ識別ヘッダー。 */
const TIMETREEA_HEADER = "web/2.1.0/ja";
/** events/sync のページングを追跡する上限。 */
const MAX_SYNC_PAGES = 200;

export type ProfileState = "ready" | "login_required" | "unknown";

export type SessionCookie = { name: string; value: string };

export type SessionFileData = {
	cookies: SessionCookie[];
	accountId?: number;
	accountName?: string;
	exportedAt?: string;
};

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type TimeTreeClientOptions = {
	profileName: string;
	sessionFile: string;
	fetchImpl?: FetchLike;
	timeoutMs?: number;
	/** セッションCookieの変更を保存先へ書き戻すか。既定は true。 */
	persistCookies?: boolean;
};

/** 正規化済みの TimeTree 要求結果。生の応答本文は外部へ出さない。 */
type ApiResult = { status: number; body: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const asNumber = (value: unknown): number | null => {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	return null;
};

const asNullableText = (value: unknown): string | null => (typeof value === "string" ? value : null);

const msToIso = (value: unknown): string | null => {
	const ms = asNumber(value);
	return ms === null ? asNullableText(value) : new Date(ms).toISOString();
};

/** タイムゾーン付きの暦日時をエポックmsへ変換する。 */
export const zonedToEpochMs = (
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
	timeZone: string,
): number => {
	const offsetAt = (utcMs: number): number => {
		let parts: Intl.DateTimeFormatPart[];
		try {
			parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(new Date(utcMs));
		} catch {
			throw new TimeTreeError("INVALID_INPUT", `タイムゾーンを解釈できません: ${timeZone}`);
		}
		const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
		const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
		if (!match) {
			throw new TimeTreeError("INVALID_INPUT", `タイムゾーンのオフセットを取得できません: ${timeZone}`);
		}
		const sign = match[1] === "-" ? -1 : 1;
		return sign * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
	};
	const guess = Date.UTC(year, month - 1, day, hour, minute, second);
	const first = guess - offsetAt(guess);
	return guess - offsetAt(first);
};

const dateOnlyToEpochMs = (date: string, timeZone: string): number => {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!match) throw new TimeTreeError("INVALID_INPUT", "日付は YYYY-MM-DD 形式で指定してください");
	const [, y, m, d] = match;
	return zonedToEpochMs(Number(y), Number(m), Number(d), 0, 0, 0, timeZone);
};

/** 追加要求の開始・終了を TimeTree のエポックmsへ変換する。 */
export const boundaryToEpochMs = (boundary: EventBoundary, timeZone: string): number => {
	if ("date" in boundary) return dateOnlyToEpochMs(boundary.date, timeZone);
	const { dateTime } = boundary;
	if (/(Z|[+-]\d{2}:\d{2})$/.test(dateTime)) {
		const parsed = Date.parse(dateTime);
		if (Number.isNaN(parsed)) {
			throw new TimeTreeError("INVALID_INPUT", "日時を解釈できません");
		}
		return parsed;
	}
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(dateTime);
	if (!match) throw new TimeTreeError("INVALID_INPUT", "日時は ISO 8601 形式で指定してください");
	const [, y, m, d, h, mi, s] = match;
	return zonedToEpochMs(Number(y), Number(m), Number(d), Number(h), Number(mi), Number(s), timeZone);
};

/** TimeTree Web の非公開 API に対する固定操作だけを実行するクライアント。 */
export class TimeTreeClient {
	readonly profileName: string;
	readonly sessionFile: string;

	#cookies = new Map<string, string>();
	#csrfToken: string | null = null;
	#state: ProfileState = "unknown";
	#user: CurrentUser | null = null;
	#fetchImpl: FetchLike;
	#timeoutMs: number;
	#persistCookies: boolean;

	constructor(options: TimeTreeClientOptions) {
		this.profileName = options.profileName;
		this.sessionFile = options.sessionFile;
		this.#fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
		this.#timeoutMs = options.timeoutMs ?? 30_000;
		this.#persistCookies = options.persistCookies ?? true;
		this.#loadSessionFile();
	}

	get state(): ProfileState {
		return this.#state;
	}

	get currentUser(): CurrentUser | null {
		return this.#user;
	}

	/** セッションファイルを読み込む。ファイルが不正な場合はエラーにする。 */
	#loadSessionFile(): void {
		if (!existsSync(this.sessionFile)) {
			this.#state = "login_required";
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.sessionFile, "utf8"));
		} catch {
			throw new TimeTreeError("SESSION_NOT_READY", `セッションファイルを読み込めません: ${this.sessionFile}`);
		}
		if (!isRecord(parsed) || !Array.isArray(parsed.cookies)) {
			throw new TimeTreeError("SESSION_NOT_READY", "セッションファイルの形式が不正です");
		}
		this.#cookies.clear();
		for (const cookie of parsed.cookies) {
			if (isRecord(cookie) && typeof cookie.name === "string" && typeof cookie.value === "string") {
				this.#cookies.set(cookie.name, cookie.value);
			}
		}
		if (!this.#cookies.has("_session_id")) {
			this.#state = "login_required";
		}
	}

	/** セッションファイルを再読み込みする（再エクスポート後に使う）。 */
	reloadSession(): void {
		this.#csrfToken = null;
		this.#user = null;
		this.#loadSessionFile();
	}

	#cookieHeader(): string {
		return [...this.#cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
	}

	/** TimeTree から返された Set-Cookie をセッションへ反映し、必要なら保存する。 */
	#absorbSetCookies(response: Response): void {
		const setCookies =
			typeof response.headers.getSetCookie === "function"
				? response.headers.getSetCookie()
				: (response.headers.get("set-cookie")?.split(/,(?=[^;]+?=)/) ?? []);
		let changed = false;
		for (const line of setCookies) {
			const [pair] = line.split(";");
			if (!pair) continue;
			const index = pair.indexOf("=");
			if (index <= 0) continue;
			const name = pair.slice(0, index).trim();
			const value = pair.slice(index + 1).trim();
			if (value === "") {
				if (this.#cookies.delete(name)) changed = true;
				continue;
			}
			if (this.#cookies.get(name) !== value) {
				this.#cookies.set(name, value);
				changed = true;
			}
		}
		if (changed && this.#persistCookies) {
			this.#writeSessionFile();
		}
	}

	#writeSessionFile(): void {
		const data: SessionFileData = {
			cookies: [...this.#cookies.entries()].map(([name, value]) => ({ name, value })),
			exportedAt: new Date().toISOString(),
		};
		if (this.#user) {
			data.accountId = this.#user.id;
			if (this.#user.name !== null) data.accountName = this.#user.name;
		}
		const directory = dirname(this.sessionFile);
		mkdirSync(directory, { recursive: true });
		const temp = `${this.sessionFile}.tmp`;
		writeFileSync(temp, JSON.stringify(data, null, "\t"), { mode: 0o600 });
		renameSync(temp, this.sessionFile);
	}

	async #rawFetch(url: string, init: RequestInit): Promise<Response> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
		try {
			return await this.#fetchImpl(url, { ...init, signal: controller.signal });
		} catch (error) {
			throw new TimeTreeError(
				"TRANSPORT_ERROR",
				`TimeTreeへの通信に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			clearTimeout(timer);
		}
	}

	#headers(opts: { json?: boolean; csrf?: boolean } = {}): Record<string, string> {
		const headers: Record<string, string> = { "X-Timetreea": TIMETREEA_HEADER };
		if (opts.json) headers["Content-Type"] = "application/json";
		if (opts.csrf && this.#csrfToken) headers["X-CSRF-Token"] = this.#csrfToken;
		const cookie = this.#cookieHeader();
		if (cookie) headers.Cookie = cookie;
		return headers;
	}

	/** 固定pathへの要求。422はCSRF失効の兆候として1回だけトークン再取得して再試行する。 */
	async #request(
		method: "GET" | "POST" | "PUT" | "DELETE",
		path: string,
		opts: { json?: unknown; expect: number[] },
	): Promise<ApiResult> {
		const unsafe = method !== "GET";
		if (unsafe && !this.#csrfToken) await this.#refreshCsrfToken();
		const attempt = async (): Promise<ApiResult> => {
			const init: RequestInit = {
				method,
				headers: this.#headers({ json: opts.json !== undefined, csrf: unsafe }),
			};
			if (opts.json !== undefined) init.body = JSON.stringify(opts.json);
			const response = await this.#rawFetch(`${API_BASE}${path}`, init);
			this.#absorbSetCookies(response);
			return { status: response.status, body: await this.#readBody(response) };
		};
		let result = await attempt();
		if (result.status === 422 && unsafe && method !== "PUT") {
			this.#csrfToken = null;
			await this.#refreshCsrfToken();
			result = await attempt();
		}
		this.#checkDefinitiveRejection(result.status);
		if (!opts.expect.includes(result.status)) {
			throw new TimeTreeError("UPSTREAM_CHANGED", `TimeTreeが予期しない応答を返しました (HTTP ${result.status})`);
		}
		return result;
	}

	async #readBody(response: Response): Promise<unknown> {
		const text = await response.text();
		if (!text) return null;
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	#checkDefinitiveRejection(status: number): void {
		if (status === 401) {
			this.#state = "login_required";
			this.#user = null;
			throw new TimeTreeError("SESSION_NOT_READY", "TimeTreeのセッションが失効しています");
		}
		if (status === 429) {
			throw new TimeTreeError("RATE_LIMITED", "TimeTreeの利用制限に達しました");
		}
	}

	/** /calendars のHTMLから Rails の CSRF トークンを取得する。 */
	async #refreshCsrfToken(): Promise<void> {
		const response = await this.#rawFetch(`${WEB_BASE}/calendars`, {
			method: "GET",
			headers: this.#headers(),
		});
		this.#absorbSetCookies(response);
		this.#checkDefinitiveRejection(response.status);
		if (response.status !== 200) {
			throw new TimeTreeError("UPSTREAM_CHANGED", `CSRFトークンを取得できませんでした (HTTP ${response.status})`);
		}
		const html = await response.text();
		const patterns = [/<meta\s+name="csrf-token"\s+content="([^"]+)"/, /<meta\s+content="([^"]+)"\s+name="csrf-token"/];
		let token: string | null = null;
		for (const pattern of patterns) {
			const match = pattern.exec(html);
			if (match?.[1]) {
				token = match[1];
				break;
			}
		}
		if (!token) {
			throw new TimeTreeError("UPSTREAM_CHANGED", "CSRFトークンをTimeTreeのHTMLから見つけられません");
		}
		this.#csrfToken = token;
	}

	/** ログインユーザーを取得してセッション状態を更新する。 */
	async checkSession(): Promise<CurrentUser> {
		const user = await this.getCurrentUser();
		this.#state = "ready";
		this.#user = user;
		return user;
	}

	async getCurrentUser(): Promise<CurrentUser> {
		const { body } = await this.#request("GET", "/user", { expect: [200] });
		const user = isRecord(body) && isRecord(body.user) ? body.user : null;
		const id = user ? asNumber(user.id) : null;
		if (id === null) {
			throw new TimeTreeError("UPSTREAM_CHANGED", "TimeTreeのユーザー応答を読み取れません");
		}
		return { id, name: asNullableText(user?.name ?? null), email: asNullableText(user?.email ?? null) };
	}

	async listCalendars(): Promise<Calendar[]> {
		const { body } = await this.#request("GET", "/calendars?since=0", { expect: [200] });
		const rawList = isRecord(body) && Array.isArray(body.calendars) ? body.calendars : null;
		if (!rawList) {
			throw new TimeTreeError("UPSTREAM_CHANGED", "TimeTreeのカレンダー応答を読み取れません");
		}
		return rawList.map((raw): Calendar => {
			// 実APIではカレンダーIDは数値で返る。
			const rawId = isRecord(raw) ? raw.id : undefined;
			const id = typeof rawId === "string" ? rawId : typeof rawId === "number" ? String(rawId) : null;
			if (!isRecord(raw) || id === null || typeof raw.name !== "string") {
				throw new TimeTreeError("UPSTREAM_CHANGED", "TimeTreeのカレンダー項目を読み取れません");
			}
			const rawLabels = Array.isArray(raw.calendar_labels) ? raw.calendar_labels : [];
			const labels = rawLabels
				.map((label): { id: number; name: string } | null => {
					if (!isRecord(label)) return null;
					const labelId = asNumber(label.id);
					if (labelId === null || typeof label.name !== "string") return null;
					return { id: labelId, name: label.name };
				})
				.filter((label): label is { id: number; name: string } => label !== null);
			// 共有カレンダーのメンバー。出席者指定に使う。
			const rawMembers = Array.isArray(raw.calendar_users) ? raw.calendar_users : [];
			const members = rawMembers
				.map((member): { userId: number; name: string } | null => {
					if (!isRecord(member)) return null;
					const userId = asNumber(member.user_id) ?? asNumber(member.id);
					if (userId === null || typeof member.name !== "string") return null;
					return { userId, name: member.name };
				})
				.filter((member): member is { userId: number; name: string } => member !== null);
			return {
				id,
				name: raw.name,
				aliasCode: asNullableText(raw.alias_code),
				deactivatedAt: msToIso(raw.deactivated_at),
				labels,
				members,
			};
		});
	}

	/** events/sync を chunk ページングで最後まで読む。 */
	async listEvents(calendarId: string): Promise<TimeTreeEvent[]> {
		const events: TimeTreeEvent[] = [];
		let since: number | undefined;
		for (let page = 0; page < MAX_SYNC_PAGES; page += 1) {
			const query = since === undefined ? "" : `?since=${since}`;
			const { body } = await this.#request("GET", `/calendar/${calendarId}/events/sync${query}`, {
				expect: [200],
			});
			if (!isRecord(body) || !Array.isArray(body.events)) {
				throw new TimeTreeError("UPSTREAM_CHANGED", "TimeTreeの予定応答を読み取れません");
			}
			events.push(...body.events.map((raw) => this.#normalizeEvent(raw)));
			if (body.chunk !== true) return events;
			const next = asNumber(body.since);
			if (next === null) {
				throw new TimeTreeError("UPSTREAM_CHANGED", "TimeTreeの予定ページングを読み取れません");
			}
			since = next;
		}
		throw new TimeTreeError("UPSTREAM_CHANGED", "TimeTreeの予定ページングが終了しません");
	}

	#normalizeEvent(raw: unknown): TimeTreeEvent {
		if (!isRecord(raw)) {
			throw new TimeTreeError("UPSTREAM_CHANGED", "TimeTreeの予定項目を読み取れません");
		}
		const id = typeof raw.uuid === "string" ? raw.uuid : typeof raw.id === "string" ? raw.id : null;
		const startAt = asNumber(raw.start_at);
		const endAt = asNumber(raw.end_at);
		if (id === null || typeof raw.title !== "string" || startAt === null || endAt === null) {
			throw new TimeTreeError("UPSTREAM_CHANGED", "TimeTreeの予定項目に必須フィールドがありません");
		}
		if (
			raw.recurrences !== undefined &&
			(!Array.isArray(raw.recurrences) || raw.recurrences.some((rule) => typeof rule !== "string"))
		) {
			throw new TimeTreeError("UPSTREAM_CHANGED", "TimeTreeの繰り返し定義を読み取れません");
		}
		const recurrenceRules = (raw.recurrences ?? []) as string[];
		const attendees = Array.isArray(raw.attendees)
			? raw.attendees
					.map((attendee) => (typeof attendee === "number" ? attendee : asNumber(attendee)))
					.filter((value): value is number => value !== null)
			: [];
		return {
			id,
			title: raw.title,
			allDay: raw.all_day === true,
			startAt: new Date(startAt).toISOString(),
			endAt: new Date(endAt).toISOString(),
			timezone: typeof raw.start_timezone === "string" ? raw.start_timezone : "UTC",
			note: asNullableText(raw.note),
			location: asNullableText(raw.location),
			labelId: asNumber(raw.label_id) ?? 0,
			attendees,
			...(recurrenceRules.length ? { recurrenceRules } : {}),
			recurring:
				recurrenceRules.length > 0 ||
				(typeof raw.recurring_uuid === "string" && raw.recurring_uuid !== "") ||
				(typeof raw.parent_id === "string" && raw.parent_id !== ""),
			category: asNumber(raw.category) ?? 0,
			url: asNullableText(raw.url),
			updatedAt: msToIso(raw.updated_at),
		};
	}

	/** 予定を追加する。応答本文は service 側で検証する。 */
	async createEvent(calendarId: string, payload: Record<string, unknown>): Promise<unknown> {
		const { body } = await this.#request("POST", `/calendar/${calendarId}/event`, {
			json: payload,
			expect: [200, 201],
		});
		return body;
	}

	/** タイトルだけを送る。更新要求は自動再送しない。 */
	async updateEventTitle(calendarId: string, eventId: string, title: string): Promise<void> {
		await this.#request("PUT", `/calendar/${calendarId}/event/${eventId}`, {
			json: { title },
			expect: [200, 204],
		});
	}

	/** 予定を削除する。204 を期待する。 */
	async deleteEvent(calendarId: string, eventId: string): Promise<void> {
		const { status } = await this.#request("DELETE", `/calendar/${calendarId}/event/${eventId}`, {
			expect: [200, 204, 404],
		});
		if (status === 404) {
			throw new TimeTreeError("NOT_FOUND", "削除対象の予定がTimeTreeに存在しません");
		}
	}
}
