# MCP

HTTPモードのRelayをstdio MCPとして利用できます。予定の確認・追加・タイトル変更・削除をエージェントから依頼できます。

MCP本体はリポジトリ内の `scripts/timetree_mcp.py` です。clone直後から、リポジトリの `packages/server` を自動で見つけてRelayを起動できます。DSH（DeepSeek Harness）へは `G:/マイドライブ/I am you/Agent/MCP/timetree` の複製をバンドル登録しています。導入手順は両方の `README.md` を参照してください。

## 環境変数

- `TIMETREE_RELAY_REPOSITORY`：Relayリポジトリの絶対パス（省略時はMCPの配置場所から自動判定）
- `TIMETREE_RELAY_API_TOKEN`：RelayのBearerトークン（省略時は `packages/server/work/relay-token.txt` を使う）
- `TIMETREE_RELAY_SETTINGS`：settings.jsonのパス（省略時は `packages/server/settings.json` → リポジトリルートの順に探す）

Relayが停止している場合はMCPが `node dist/server.js` を起動します（Bearerトークンは `work/relay-token.txt` から渡します）。

## 接続確認

stdio経由の動作確認には `scripts/mcp_smoke.py` を使う。MCPを起動し、初期化・ツール一覧・`timetree_status`・`timetree_list_calendars`（読み取りのみ）を検証する。

```powershell
$env:PYTHONUTF8 = '1'
python scripts/mcp_smoke.py
```

## ツール一覧

- `timetree_status`：接続・登録アカウント・選択中の操作先を確認する。最初に必ず実行する。
- `timetree_list_calendars`：操作できるカレンダーの一覧を返す。共有カレンダーはラベルとメンバーも含む。
- `timetree_list_events(calendar, days)`：今日以降指定日数分の予定を返す。`calendar` は名前でもIDでも指定できる。予定にはラベル名も付く。
- `timetree_add_event(calendar, title, date, start_time, end_time, all_day, note, location, timezone, label, attendees)`：予定を1件追加する。`start_time` がないか `all_day` なら終日予定にする。`label` はラベル名かID、`attendees` は共有カレンダーのメンバー名かユーザーIDで指定する。
- `timetree_update_event_title(calendar, event_id, expected_title, expected_updated_at, title, request_id)`：予定のタイトルだけを変更する。事前に一覧から現在のタイトルと `updatedAt` を取得して渡す。繰り返し予定は変更しない。
- `timetree_delete_event(calendar, event_id | title+date, allow_series)`：予定を1件削除する。タイトルと日付で複数候補が命中した場合は削除せず候補を返す。

## 再送禁止ルール

- 追加・削除・タイトル変更はユーザーの明示的な依頼があるときだけ行う。
- 操作はIdempotency-Key（UUID）で管理される。処理中・結果不明の操作は同じジョブIDで `GET /v1/event-jobs/:id` を確認し、**新しいキーで再送しない**。
- `unknown` のジョブはTimeTree上でユーザーが確認する。台帳を削除しない。
- 繰り返し予定の削除は系列全体へ影響するため、`allow_series` はユーザーの明示的な確認なしには指定しない。
- ログイン・パスワード入力・2FA・アカウント設定の自動化は提供しない。
