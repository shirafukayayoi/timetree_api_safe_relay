/**
 * 実TimeTreeへ接続するsmoke test。通常のCIには含めない。
 * ログイン済みセッションファイルがある状態で、リポジトリルートから明示的に実行する:
 *   pnpm test:live
 *
 * 先頭プロファイルで、カレンダー一覧・予定一覧を読み、明日のテスト予定を1件追加して読み戻し、
 * 削除して消失を確認する。
 */
import { resolve } from "node:path";
import { TimeTreeClient, loadSettings } from "../packages/server/src/index.js";

const settings = loadSettings(resolve(process.cwd(), "../../settings.json"));
const profile = settings.profiles[0];
if (!profile) {
	throw new Error("設定にプロファイルがありません");
}
const client = new TimeTreeClient({
	profileName: profile.name,
	sessionFile: resolve(process.cwd(), profile.browser.sessionFile),
	timeoutMs: settings.requestTimeoutMs,
});

const step = (message: string) => console.log(`[smoke] ${message}`);

const user = await client.checkSession();
step(`ログイン確認: id=${user.id} name=${user.name ?? "(不明)"}`);

const calendars = await client.listCalendars();
const active = calendars.filter((calendar) => calendar.deactivatedAt === null);
step(`カレンダー一覧: ${active.length}件 (${active.map((c) => c.name).join(", ")})`);

const calendar = active[0];
if (!calendar) {
	throw new Error("操作できるカレンダーがありません");
}
const before = await client.listEvents(calendar.id);
step(`予定一覧: ${before.length}件`);

const timezone = settings.defaultTimezone;
const now = new Date();
const tommorow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
const y = tommorow.getFullYear();
const m = `${tommorow.getMonth() + 1}`.padStart(2, "0");
const d = `${tommorow.getDate()}`.padStart(2, "0");
const title = `Relay動作確認 ${now.toISOString()}`;

step(`テスト予定を追加します: ${title} (${y}-${m}-${d} 10:00-11:00 ${timezone})`);
const createdPayload = {
	title,
	all_day: false,
	start_at: Date.parse(`${y}-${m}-${d}T10:00:00+09:00`),
	start_timezone: timezone,
	end_at: Date.parse(`${y}-${m}-${d}T11:00:00+09:00`),
	end_timezone: timezone,
	label_id: 1,
	note: "smoke test",
	location: "",
	attendees: [user.id],
	recurrences: [],
	alerts: [],
	attachment: { virtual_user_attendees: [] },
	category: 1,
};
const response = await client.createEvent(calendar.id, createdPayload);
const createdId =
	typeof response === "object" && response !== null
		? (((response as Record<string, unknown>).event as Record<string, unknown> | undefined)?.uuid ??
			(response as Record<string, unknown>).uuid ??
			(response as Record<string, unknown>).id)
		: null;
if (typeof createdId !== "string") {
	throw new Error(`追加応答からイベントIDを確認できませんでした: ${JSON.stringify(response)}`);
}
const afterCreate = await client.listEvents(calendar.id);
const created = afterCreate.find((event) => event.id === createdId);
if (!created || created.title !== title) {
	throw new Error("追加した予定を読み戻しで確認できませんでした");
}
step(`追加を確認しました: ${createdId}`);

await client.deleteEvent(calendar.id, createdId);
const afterDelete = await client.listEvents(calendar.id);
if (afterDelete.some((event) => event.id === createdId)) {
	throw new Error("削除した予定がまだ存在します");
}
step("削除と消失を確認しました");
step("smoke test 完了");
