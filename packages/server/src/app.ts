import { type Context, Hono } from "hono";
import type { AccountService } from "./accounts/service.js";
import { mountAccountRoutes } from "./accounts/routes.js";
import { mountEventRoutes } from "./events/routes.js";
import type { EventService } from "./events/service.js";
import type { RelayProfile } from "./types.js";
import { isAllowedHost, isAuthorized } from "./utils/auth.js";
import { SerialQueue } from "./utils/queue.js";

export type CreateAppOptions = {
	profiles: RelayProfile[];
	token: string;
	accounts: AccountService;
	events: EventService;
};

export const createApp = ({ profiles, token, accounts, events }: CreateAppOptions) => {
	const app = new Hono();
	const queues = new Map(profiles.map((profile) => [profile.name, new SerialQueue()]));
	const resolveProfile = (header: string | undefined): RelayProfile | undefined => {
		if (header) return profiles.find((profile) => profile.name === header);
		return profiles.length === 1 ? profiles[0] : undefined;
	};

	app.use("*", async (c, next) => {
		if (!isAllowedHost(c.req.header("host"))) {
			return c.json({ error: { code: "AUTH_REQUIRED", message: "Hostが許可されていません" } }, 403);
		}
		c.header("Cache-Control", "no-store");
		c.header("X-Content-Type-Options", "nosniff");
		c.header("X-Frame-Options", "DENY");
		c.header("Referrer-Policy", "no-referrer");
		c.header("Cross-Origin-Resource-Policy", "same-origin");
		c.header("Cross-Origin-Opener-Policy", "same-origin");
		c.header(
			"Content-Security-Policy",
			"default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
		);
		await next();
	});

	app.get("/health", (c) => c.json({ status: "ok" }));

	app.use("/v1/*", async (c, next) => {
		if (!isAuthorized(c.req.header("authorization"), token)) {
			return c.json({ error: { code: "AUTH_REQUIRED", message: "Bearerトークンが必要です" } }, 401);
		}
		await next();
	});
	app.use("/profiles", async (c, next) => {
		if (!isAuthorized(c.req.header("authorization"), token)) {
			return c.json({ error: { code: "AUTH_REQUIRED", message: "Bearerトークンが必要です" } }, 401);
		}
		await next();
	});

	app.get("/profiles", (c) =>
		c.json({
			profiles: profiles.map((profile) => ({
				name: profile.name,
				state: profile.client.state,
			})),
		}),
	);

	mountAccountRoutes(app, accounts);
	mountEventRoutes({ app, service: events, queues, resolveProfile });

	app.notFound((c: Context) => c.json({ error: { code: "NOT_FOUND", message: "要求されたパスは存在しません" } }, 404));

	return app;
};
