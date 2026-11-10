import { readFileSync } from "node:fs";
import { z } from "zod";

export const profileSchema = z.strictObject({
	name: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.regex(/^[A-Za-z0-9_-]+$/, "プロファイル名は英数字と _- だけを使用してください"),
	home: z.string().url().optional(),
	browser: z.strictObject({
		type: z.literal("http"),
		sessionFile: z.string().min(1),
	}),
});

export const settingsSchema = z.strictObject({
	port: z.number().int().min(1).max(65535).default(3100),
	logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
	defaultTimezone: z.string().trim().min(1).default("Asia/Tokyo"),
	sessionCheckIntervalSeconds: z.number().int().min(5).default(30),
	requestTimeoutMs: z.number().int().min(1000).default(30_000),
	accounts: z
		.strictObject({
			enabled: z.boolean().default(true),
			accountSelectionFile: z.string().min(1).default("../../work/skill-relay/selected-account.json"),
		})
		.default({}),
	events: z
		.strictObject({
			enabled: z.boolean().default(true),
			stateDir: z.string().min(1).default("./event_data"),
			operationTimeoutMs: z.number().int().min(1000).default(60_000),
		})
		.default({}),
	profiles: z.array(profileSchema).min(1),
});

export type Settings = z.infer<typeof settingsSchema>;

/** settings.json を読み込む。相対パスは relay の作業ディレクトリが基準。 */
export const loadSettings = (path: string): Settings => {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		throw new Error(`設定ファイルを読み込めません: ${path}`);
	}
	const parsed: unknown = JSON.parse(raw);
	const result = settingsSchema.safeParse(parsed);
	if (!result.success) {
		const issue = result.error.issues[0];
		const where = issue?.path?.length ? ` (${issue.path.join(".")})` : "";
		throw new Error(`設定が不正です: ${issue?.message ?? "不明なエラー"}${where}`);
	}
	return result.data;
};
