import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { selectAccountInputSchema } from "timetree-api-safe-contracts";
import type { AccountService } from "./service.js";
import { fail } from "../utils/errors.js";

export const mountAccountRoutes = (app: Hono, accounts: AccountService): void => {
	app.get("/v1/accounts", (c) => c.json({ data: accounts.list() }));

	app.use(
		"/v1/accounts/select",
		bodyLimit({
			maxSize: 4096,
			onError: (c) =>
				c.json({ error: { code: "INVALID_INPUT", message: "要求のJSONは4KiB以下で指定してください" } }, 413),
		}),
	);

	app.post("/v1/accounts/select", async (c) => {
		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			return fail(c, { code: "INVALID_INPUT", message: "JSON本文を解析できません" });
		}
		const parsed = selectAccountInputSchema.safeParse(raw);
		if (!parsed.success) {
			return fail(c, { code: "INVALID_INPUT", message: "アカウント選択の入力が不正です" });
		}
		try {
			const selected = await accounts.select(parsed.data);
			return c.json({ data: selected });
		} catch (error) {
			return fail(c, error);
		}
	});
};
