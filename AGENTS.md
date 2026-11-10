# AGENTS.md

## このリポジトリの方針

- TimeTree Webの非公開API（`https://timetreeapp.com/api/v1`）を使う実験的なRelay。自分のアカウントでの個人的利用だけを想定する。
- 固定操作（getCurrentUser / listCalendars / listEvents / createEvent / deleteEvent）だけを提供し、任意URL・汎用プロキジ・raw request/responseは公開しない。
- パスワード・メールアドレスを保存せず、ログイン・2FAを自動化しない。認証は手動エクスポートしたセッションCookieのみ。
- セッションCookie・CSRFトークンをログ・API応答・MCPへ出さない。
- 追加・削除はIdempotency-Key付きジョブで行い、失敗・結果不明の自動再送をしない。再起動時は作成中/削除中を `unknown`、待機中を `failed/INTERRUPTED` にする。
- 繰り返し予定の削除には `allowSeries` が必須。削除後は消失を確認してから `deleted` にする。
- 未知の応答形状は `UPSTREAM_CHANGED` として停止し、推測したパラメータで再試行しない。

## 作業ルール

- 通常のコミット前に `pnpm type-check` / `pnpm test` / `pnpm lint` を通す。
- 実TimeTreeへ接続するテスト（`pnpm test:live`・手動確認）はユーザーの明示的な許可があるときだけ実行する。
- `private_sessions/`・`packages/server/user_data/`・`packages/server/event_data/`・`settings.json` をコミットしない。
- 日本語でコミットメッセージ・ドキュメントを書く。
