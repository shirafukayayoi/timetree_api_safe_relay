# セッションCookie方式（HTTPモード）

RelayはChromium・Playwrightのブラウザープロセスを常駐させず、TimeTree Webの非公開APIへNode.jsのHTTP通信でアクセスします。認証はセッションCookie（`_session_id`）だけを使い、メールアドレス・パスワードをディスクへ保存しません。

## 仕組み

- TimeTree Webアプリと同じ固定エンドポイント（`https://timetreeapp.com/api/v1`）だけを呼び出します。
- 更新系（追加・削除）には、`GET /calendars` のHTMLから取得したRailsのCSRFトークンを `X-CSRF-Token` へ付けます。`422` はトークン失効の兆候として1回だけ再取得して再試行します。
- `401` はセッション失効とし、`SESSION_NOT_READY` を返して停止します。自動再ログインは行いません。
- TimeTreeが `_session_id` を更新した場合（Set-Cookie）、同じローカルセッションファイルへ保存し直します。

## セッションのエクスポート

`pnpm sessions:export --name account1` は次を行います。

1. 専用Playwrightプロファイル（`packages/server/user_data/account1`）でheadedのChromiumを起動します。
2. ユーザーが timetreeapp.com へ手動ログインします（パスワード入力・2FAの自動化は行いません）。
3. `GET /api/v1/user` が200を返すことを繰り返し確認し、実アカウントID・名前を記録します。
4. CookieをGit管理外の `private_sessions/account1.json`（権限600）へ保存します。既存ファイルは `--force` なしには上書きしません。

Playwrightは自分で起動したプロファイルのCookieを直接読めるため、Instagram relayのようなkeyring復号は不要です。

## セッション失効時の手順

1. Relayを停止します。
2. `pnpm sessions:export --name account1 --force` で再ログイン・再エクスポートします。
3. Relayを起動します。台帳（`event_data/`）と選択記録は保持されます。

## セキュリティ

- セッションファイルと `private_sessions/`・`packages/server/user_data/` はGit管理外です。
- 認証値・CSRFトークンはAPI応答・ログ・MCPへ含めません。
- Relayは `127.0.0.1` のみbindし、Bearerトークン認証が必須です。
