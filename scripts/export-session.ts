/**
 * 専用PlaywrightプロファイルでTimeTreeへ手動ログインし、セッションCookieを
 * Git管理外のセッションファイルへ書き出す。パスワード入力・2FAの自動化はしない。
 *
 * 使い方（リポジトリルートから）:
 *   pnpm sessions:export --name account1 [--force] [--timeout-seconds 300]
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

// pnpmの分離配置に合わせ、依存を宣言しているserverパッケージから解決する。
const { chromium } = createRequire(new URL("../packages/server/package.json", import.meta.url))("playwright") as {
	chromium: typeof import("playwright").chromium;
};

const args = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? args[index + 1] : undefined;
};

const name = argValue("name");
if (!name || name.startsWith("--")) {
	console.error("使い方: pnpm sessions:export --name <プロファイル名> [--force] [--timeout-seconds 300]");
	process.exit(1);
}
const force = args.includes("--force");
const timeoutSeconds = Number(argValue("timeout-seconds") ?? 300);

/** このスクリプトは packages/server を作業ディレクトリとして実行される。 */
const workingDir = process.cwd();
const userDataDir = resolve(workingDir, "user_data", name);
const sessionFile = resolve(workingDir, "../../private_sessions", `${name}.json`);

if (existsSync(sessionFile) && !force) {
	console.error(`セッションファイルが既に存在します: ${sessionFile}`);
	console.error("上書きするには --force を指定してください。既存のセッションは失われます");
	process.exit(1);
}

console.log(`専用ブラウザープロファイル: ${userDataDir}`);
console.log("TimeTreeのログイン画面が開きます。手動でログインしてください（自動入力は行いません）");

const context = await chromium.launchPersistentContext(userDataDir, {
	headless: false,
	viewport: { width: 1280, height: 900 },
});

try {
	const page = await context.newPage();
	await page.goto("https://timetreeapp.com/calendars").catch(() => undefined);

	const headers = { "X-Timetreea": "web/2.1.0/ja" };
	const deadline = Date.now() + timeoutSeconds * 1000;
	let user: { id?: number; name?: string } | null = null;
	while (Date.now() < deadline) {
		const response = await context.request.get("https://timetreeapp.com/api/v1/user", { headers });
		if (response.status() === 200) {
			try {
				const body = (await response.json()) as { user?: { id?: number; name?: string } };
				if (body.user?.id !== undefined) {
					user = body.user;
					break;
				}
			} catch {
				// 応答が読めなければ待機して再試行する
			}
		}
		await page.waitForTimeout(2000);
	}
	if (!user) {
		console.error(`${timeoutSeconds}秒以内にログインを確認できませんでした。再度実行してください`);
		process.exit(1);
	}

	const cookies = (await context.cookies("https://timetreeapp.com")).map((cookie) => ({
		name: cookie.name,
		value: cookie.value,
	}));
	if (!cookies.some((cookie) => cookie.name === "_session_id")) {
		console.error("TimeTreeのセッションCookieを取得できませんでした");
		process.exit(1);
	}

	const data = {
		cookies,
		accountId: user.id,
		accountName: user.name ?? undefined,
		exportedAt: new Date().toISOString(),
	};
	mkdirSync(dirname(sessionFile), { recursive: true });
	const temp = `${sessionFile}.tmp`;
	writeFileSync(temp, JSON.stringify(data, null, "\t"), { mode: 0o600 });
	renameSync(temp, sessionFile);
	console.log(`セッションを保存しました: ${sessionFile}`);
	console.log(`アカウント: id=${user.id} name=${user.name ?? "(不明)"}`);
	console.log("Relayを起動（または再起動）すると、このセッションを使います");
} finally {
	await context.close();
}
