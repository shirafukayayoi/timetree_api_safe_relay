import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import pino from "pino";
import { createApp } from "./app.js";
import { AccountService } from "./accounts/service.js";
import { EventService } from "./events/service.js";
import { TimeTreeClient } from "./timetree/client.js";
import type { RelayProfile } from "./types.js";
import { loadSettings } from "./utils/settings.js";

const settingsPath =
	process.env.TIMETREE_RELAY_SETTINGS !== undefined
		? resolve(process.env.TIMETREE_RELAY_SETTINGS)
		: [resolve(process.cwd(), "settings.json"), resolve(process.cwd(), "../../settings.json")].find(
				(path) => existsSync(path),
			) ?? resolve(process.cwd(), "../../settings.json");

const settings = loadSettings(settingsPath);

const token = process.env.TIMETREE_RELAY_API_TOKEN;
if (!token || token.length < 16) {
	console.error("環境変数 TIMETREE_RELAY_API_TOKEN に16文字以上のトークンを設定してください");
	process.exit(1);
}

const logger = pino({
	level: settings.logLevel,
	transport:
		process.env.NODE_ENV === "production"
			? undefined
			: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } },
});

const profiles: RelayProfile[] = settings.profiles.map((profile) => ({
	name: profile.name,
	client: new TimeTreeClient({
		profileName: profile.name,
		sessionFile: resolve(process.cwd(), profile.browser.sessionFile),
		timeoutMs: settings.requestTimeoutMs,
	}),
}));

const accounts = new AccountService({
	profiles,
	selectionFile: resolve(process.cwd(), settings.accounts.accountSelectionFile),
	logger,
});

const events = new EventService({
	stateDir: resolve(process.cwd(), settings.events.stateDir),
	defaultTimezone: settings.defaultTimezone,
	logger,
});

const app = createApp({ profiles, token, accounts, events });

serve({ fetch: app.fetch, hostname: "127.0.0.1", port: settings.port }, (info) => {
	logger.info(`TimeTree safe relay: http://127.0.0.1:${info.port}`);
});

const checkSessions = async () => {
	for (const profile of profiles) {
		try {
			const user = await profile.client.checkSession();
			logger.info(`プロファイル ${profile.name}: ログイン中 (id=${user.id})`);
		} catch (error) {
			logger.warn(
				`プロファイル ${profile.name}: セッションを確認できません (${error instanceof Error ? error.message : String(error)})`,
			);
		}
	}
};

void checkSessions();
const sessionTimer = setInterval(() => {
	void checkSessions();
}, settings.sessionCheckIntervalSeconds * 1000);
sessionTimer.unref?.();
