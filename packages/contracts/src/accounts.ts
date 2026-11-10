import { z } from "zod";
import { nonNegativeInteger, nullableText, idempotencyKeySchema, calendarIdSchema } from "./events.js";

export const accountStateSchema = z.enum(["ready", "login_required", "unknown"]);
export type AccountState = z.infer<typeof accountStateSchema>;

/** 登録済みプロファイルの状態。認証値は含めない。 */
export const accountInfoSchema = z.strictObject({
	profile: z.string().min(1),
	state: accountStateSchema,
	accountId: nonNegativeInteger.nullable(),
	accountName: nullableText,
});

export type AccountInfo = z.infer<typeof accountInfoSchema>;

export const selectedAccountSchema = z.strictObject({
	profile: z.string().min(1),
	accountId: nonNegativeInteger,
	accountName: z.string(),
});

export type SelectedAccount = z.infer<typeof selectedAccountSchema>;

export const accountListingSchema = z.strictObject({
	accounts: z.array(accountInfoSchema),
	selected: selectedAccountSchema.nullable(),
});

export type AccountListing = z.infer<typeof accountListingSchema>;

/** アカウント選択の入力。expectedAccountId は一覧を見て選ぶUI・MCPで指定する。 */
export const selectAccountInputSchema = z.strictObject({
	profile: z.string().min(1),
	expectedAccountId: nonNegativeInteger.optional(),
});

export type SelectAccountInput = z.infer<typeof selectAccountInputSchema>;

/** 台帳に保存する選択記録。 */
export const accountSelectionRecordSchema = z.strictObject({
	profile: z.string().min(1),
	accountId: nonNegativeInteger,
	accountName: z.string(),
	savedAt: z.string(),
});

export type AccountSelectionRecord = z.infer<typeof accountSelectionRecordSchema>;

/** ジョブ要求の共通ヘッダー検証に使うキー。 */
export { idempotencyKeySchema, calendarIdSchema };
