# MCP

HTTPモードのRelayをstdio MCPとして利用できます。予定の確認・追加・削除をエージェントから依頼できます。

## 導入

```powershell
pip install -r scripts/mcp-requirements.txt
```

環境変数:

- `TIMETREE_RELAY_API_TOKEN`：RelayのBearerトークン（必須）
- `TIMETREE_RELAY_SETTINGS`：settings.jsonのパス（省略時は `packages/server/settings.json` → リポジトリルートの順に探す）

Relayが停止している場合はMCPが `pnpm start:relay` を起動します。

Codex等への登録例（`~/.codex/config.toml`）。トークンは環境変数へ渡す:

```toml
[mcp_servers.timetree]
command = 'C:/Users/ron06/AppData/Local/Programs/Python/Python314/python.exe'
args = ['<リポジトリの絶対パス>/scripts/timetree_mcp.py']
startup_timeout_sec = 20
tool_timeout_sec = 120

[mcp_servers.timetree.env]
TIMETREE_RELAY_API_TOKEN = '<トークン>'
```

## 接続確認

stdio経由の動作確認には `scripts/mcp_smoke.py` を使う。Relayが稼働していれば、初期化・ツール一覧・`timetree_status`・`timetree_list_calendars`（読み取りのみ）を検証する。

```powershell
$env:PYTHONUTF8 = '1'
python scripts/mcp_smoke.py
```

## ツール一覧

- `timetree_status`：接続・登録アカウント・選択中の操作先を確認する。最初に必ず実行する。
- `timetree_list_calendars`：操作できるカレンダーの一覧を返す。共有カレンダーはラベルとメンバーも含む。
- `timetree_list_events(calendar, days)`：今日以降指定日数分の予定を返す。`calendar` は名前でもIDでも指定できる。予定にはラベル名も付く。
- `timetree_add_event(calendar, title, date, start_time, end_time, all_day, note, location, timezone, label, attendees)`：予定を1件追加する。`start_time` がないか `all_day` なら終日予定にする。`label` はラベル名かID、`attendees` は共有カレンダーのメンバー名かユーザーIDで指定する。
- `timetree_delete_event(calendar, event_id | title+date, allow_series)`：予定を1件削除する。タイトルと日付で複数候補が命中した場合は削除せず候補を返す。

## 再送禁止ルール

- 追加・削除はユーザーの明示的な依頼があるときだけ行う。
- 操作はIdempotency-Key（UUID）で管理される。処理中・結果不明の操作は同じジョブIDで `GET /v1/event-jobs/:id` を確認し、**新しいキーで再送しない**。
- `unknown` のジョブはTimeTree上でユーザーが確認する。台帳を削除しない。
- 繰り返し予定の削除は系列全体へ影響するため、`allow_series` はユーザーの明示的な確認なしには指定しない。
- ログイン・パスワード入力・2FA・アカウント設定の自動化は提供しない。
