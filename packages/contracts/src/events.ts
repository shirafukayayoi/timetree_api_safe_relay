import { z } from "zod";

/** TimeTree Web クライアントが使う非公開 API のうち、Relay が利用する固定操作。 */
export const operationNames = ["getCurrentUser", "listCalendars", "listEvents", "createEvent", "deleteEvent"] as const;

export type OperationName = (typeof operationNames)[number];

/** Idempotency-Key。1〜128文字の英数字と ._:- 。 */
export const idempotencyKeySchema = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9._:-]+$/, "Idempotency-Key は英数字と ._:- だけを使用してください");

export const calendarIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/, "calendarId は TimeTree のカレンダーID形式で指定してください");

export const eventIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9_-]+$/, "eventId は TimeTree のイベントID形式で指定してください");

export const nullableText = z.string().nullable();
const nullableUrl = z.string().url().nullable();
export const nonNegativeInteger = z.number().int().nonnegative();

/** IANA タイムゾーン名（例: Asia/Tokyo）。 */
export const timezoneSchema = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_+\-/]+$/, "timezone は IANA タイムゾーン名で指定してください");

const isoInstantSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, "ISO 8601 の日時で指定してください");

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 形式で指定してください");

/** 終日予定の日付、または時刻付き予定の日時。 */
export const eventBoundarySchema = z.union([
	z.strictObject({ date: dateOnlySchema }),
	z.strictObject({ dateTime: isoInstantSchema }),
]);

export type EventBoundary = z.infer<typeof eventBoundarySchema>;

/** 追加操作の入力。 */
export const createEventInputSchema = z.strictObject({
	calendarId: calendarIdSchema,
	title: z.string().trim().min(1).max(200),
	allDay: z.boolean().optional(),
	start: eventBoundarySchema,
	end: eventBoundarySchema.optional(),
	timezone: timezoneSchema.optional(),
	note: z.string().max(2000).optional(),
	location: z.string().max(200).optional(),
	labelId: nonNegativeInteger.optional(),
	attendees: z.array(nonNegativeInteger).max(30).optional(),
});

export type CreateEventInput = z.infer<typeof createEventInputSchema>;

/** 削除操作の入力。繰り返し予定は allowSeries なしでは拒否する。 */
export const deleteEventInputSchema = z.strictObject({
	calendarId: calendarIdSchema,
	eventId: eventIdSchema,
	allowSeries: z.boolean().optional(),
});

export type DeleteEventInput = z.infer<typeof deleteEventInputSchema>;

/** 一覧取得の入力。 */
export const listEventsInputSchema = z.strictObject({
	calendarId: calendarIdSchema,
	from: isoInstantSchema.optional(),
	to: isoInstantSchema.optional(),
});

export type ListEventsInput = z.infer<typeof listEventsInputSchema>;

/** TimeTree から読み取って正規化したカレンダー。 */
export const calendarSchema = z.strictObject({
	id: z.string().min(1),
	name: z.string(),
	aliasCode: nullableText,
	deactivatedAt: nullableText,
	labels: z.array(
		z.strictObject({
			id: nonNegativeInteger,
			name: z.string(),
		}),
	),
	members: z.array(
		z.strictObject({
			userId: nonNegativeInteger,
			name: z.string(),
		}),
	),
});

export type Calendar = z.infer<typeof calendarSchema>;

/** TimeTree から読み取って正規化した予定。 */
export const timeTreeEventSchema = z.strictObject({
	id: z.string().min(1),
	title: z.string(),
	allDay: z.boolean(),
	startAt: isoInstantSchema,
	endAt: isoInstantSchema,
	timezone: timezoneSchema,
	note: nullableText,
	location: nullableText,
	labelId: nonNegativeInteger,
	attendees: z.array(nonNegativeInteger),
	recurring: z.boolean(),
	category: nonNegativeInteger,
	url: nullableUrl,
	updatedAt: nullableText,
});

export type TimeTreeEvent = z.infer<typeof timeTreeEventSchema>;

/** ログインユーザー。アカウント照合に使う。 */
export const currentUserSchema = z.strictObject({
	id: nonNegativeInteger,
	name: nullableText,
	email: nullableText,
});

export type CurrentUser = z.infer<typeof currentUserSchema>;

export const calendarListSchema = z.strictObject({
	items: z.array(calendarSchema),
});

export const eventListSchema = z.strictObject({
	items: z.array(timeTreeEventSchema),
});

/** ジョブの状態。作成と削除で進行中の状態だけが異なる。 */
export const jobStateSchema = z.enum([
	"queued",
	"validating",
	"creating",
	"deleting",
	"created",
	"deleted",
	"failed",
	"unknown",
]);

export type JobState = z.infer<typeof jobStateSchema>;

export const jobKindSchema = z.enum(["create", "delete"]);
export type JobKind = z.infer<typeof jobKindSchema>;

export const jobFailureSchema = z.strictObject({
	code: z.string().min(1),
	message: z.string(),
});

export type JobFailure = z.infer<typeof jobFailureSchema>;

/** 追加・削除ジョブ。台帳とAPI応答で共用する。 */
export const eventJobSchema = z.strictObject({
	id: z.string().min(1),
	kind: jobKindSchema,
	state: jobStateSchema,
	profile: z.string().min(1),
	key: idempotencyKeySchema,
	request: z.union([createEventInputSchema, deleteEventInputSchema]),
	eventId: eventIdSchema.nullable(),
	failure: jobFailureSchema.nullable(),
	createdAt: isoInstantSchema,
	updatedAt: isoInstantSchema,
});

export type EventJob = z.infer<typeof eventJobSchema>;

/** ジョブの進行中（未確定）状態。再起動時は unknown または failed に移す。 */
export const inFlightJobStates = ["queued", "validating", "creating", "deleting"] as const;

export const isJobInFlight = (state: JobState): boolean => (inFlightJobStates as readonly string[]).includes(state);

/** 操作名と入力スキーマの対応。すべて strict object である。 */
export const operationInputSchemas = {
	getCurrentUser: z.strictObject({}),
	listCalendars: z.strictObject({}),
	listEvents: listEventsInputSchema,
	createEvent: createEventInputSchema,
	deleteEvent: deleteEventInputSchema,
} as const;

export type OperationInputMap = {
	getCurrentUser: z.infer<(typeof operationInputSchemas)["getCurrentUser"]>;
	listCalendars: z.infer<(typeof operationInputSchemas)["listCalendars"]>;
	listEvents: ListEventsInput;
	createEvent: CreateEventInput;
	deleteEvent: DeleteEventInput;
};

export type OperationInput<TName extends OperationName> = OperationInputMap[TName];

export const parseOperationInput = <TName extends OperationName>(
	operation: TName,
	rawInput: unknown,
): OperationInput<TName> => {
	const schema = operationInputSchemas[operation] as z.ZodType;
	const result = schema.safeParse(rawInput);
	if (!result.success) {
		const issue = result.error.issues[0];
		const path = issue?.path?.length ? ` (${issue.path.join(".")})` : "";
		throw Object.assign(new Error(`${issue?.message ?? "入力が不正です"}${path}`), {
			code: "INVALID_INPUT",
		});
	}
	return result.data as OperationInput<TName>;
};
