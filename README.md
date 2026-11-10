# timetree-api-safe-relay

timetreeapp.com の自分のカレンダーへ、予定の**追加・削除・一覧**だけを行えるlocalhost限定のHTTP Relayです。構造と設計は [instagram_api_safe_relay](https://github.com/shirafukayayoi/instagram_api_safe_relay) を参考にしています。

## 重要な注意

TimeTreeの公式OAuth APIは2023年12月に終了しました。本RelayはTimeTree Webアプリ（timetreeapp.com）が使う非公開API（`https://timetreeapp.com/api/v1`）を利用します。非公開APIであり、仕様変更で動作しなくなる可能性があります。未知の応答形状は `UPSTREAM_CHANGED` として停止し、推測したパラメータでの再試行は行いません。

`safe` は次を指します:

- パスワード・メールアドレスをディスクへ保存せず、ログインの自動化をしない
- セッションCookieとCSRFトークンを応答・ログへ出さない
- 任意URL・汎用プロキシ・raw request/responseを公開しない
- 予定の追加・削除はIdempotency-Keyで管理し、失敗・結果不明の自動再送をしない
- 繰り返し予定の削除は `allowSeries` なしには拒否する（系列全体が削除されるため）
- `127.0.0.1` のみbindし、Bearerトークン認証を必須にする

自分のアカウントでの個人的利用を想定しています。予定の変更（更新）・コメント・メンバー操作・カレンダー作成などは対象外です。

## パッケージ

- `timetree-api-safe-contracts`: 操作・ジョブ・エラーのzod契約
- `timetree-api-safe-relay`: localhost限定のHTTP relay（Hono）
- `scripts/timetree_mcp.py`: stdio MCPサーバー

固定操作は次の5つだけです:

- `getCurrentUser`
- `listCalendars`
- `listEvents`
- `createEvent`
- `deleteEvent`

## セットアップ

Node.js 24・pnpm 11.5.0を使用します。

```powershell
corepack enable
pnpm install
pnpm build
Copy-Item settings.example.json settings.json
$env:TIMETREE_RELAY_API_TOKEN = -join ((1..48) | ForEach-Object { [char](Get-Random -Minimum 48 -Maximum 123) })
```

### セッションの作成

初回のみ、専用ブラウザープロファイルで手動ログインし、セッションCookieを書き出します。パスワード入力・2FAの自動化は行いません。

```powershell
pnpm sessions:export --name account1
```

TimeTreeのログイン画面が開くので手動でログインしてください。ログインを確認したら、`_session_id` などのCookieをGit管理外の `private_sessions/account1.json` へ保存します。既存ファイルの上書きには `--force` が必要です。

セッションが失効したら、Relayを停止してから同じコマンドで再エクスポートし、Relayを再起動します。自動再ログインは行いません。

### 起動

```powershell
pnpm start:relay
```

Relayは常に `127.0.0.1` へbindします。セッションを定期確認し、`ready` / `login_required` / `unknown` を `/v1/profiles` へ反映します。TimeTreeが `_session_id` を更新した場合は同じローカルファイルへ保存し直します。

## HTTP API

```powershell
$headers = @{ Authorization = "Bearer $env:TIMETREE_RELAY_API_TOKEN" }
# カレンダー一覧
Invoke-RestMethod -Headers $headers http://127.0.0.1:3100/v1/calendars
# 予定一覧（範囲でフィルター）
Invoke-RestMethod -Headers $headers 'http://127.0.0.1:3100/v1/events?calendarId=CALENDAR_ID&from=2026-11-01T00:00:00Z&to=2026-11-30T23:59:59Z'
```

複数プロファイルを設定した場合は `x-profile-name` ヘッダーが必須です。すべての応答は `Cache-Control: no-store` です。

### 予定の追加

```powershell
$headers = @{ Authorization = "Bearer $env:TIMETREE_RELAY_API_TOKEN"; "Idempotency-Key" = "event-20261120-001" }
$body = @{
	calendarId = "確認したカレンダーID"
	title = "歯科検診"
	allDay = $false
	start = @{ dateTime = "2026-11-20T10:00:00+09:00" }
	end = @{ dateTime = "2026-11-20T11:00:00+09:00" }
	timezone = "Asia/Tokyo"
} | ConvertTo-Json
$job = Invoke-RestMethod -Method Post -Headers $headers -ContentType 'application/json' -Body $body http://127.0.0.1:3100/v1/events
Invoke-RestMethod -Headers $headers "http://127.0.0.1:3100/v1/event-jobs/$($job.data.id)"
```

- `POST /v1/events` は `202` とジョブを受け付け、`GET /v1/event-jobs/:id` で `queued → validating → creating → created` を確認します。
- 終日予定は `start = @{ date = "2026-11-20" }` とし、`allDay = $true` を指定します（`end` は省略できます）。
- 追加応答のイベントID取得後、`events/sync` で読み戻してID・タイトル・開始時刻が一致した場合だけ `created` にします。応答喪失などは `unknown` です。
- 同じキーで同じ要求は既存ジョブを返し、異なる要求は `409` です。
- `timezone` を省略した場合は設定の `defaultTimezone`（既定 `Asia/Tokyo`）を使います。
- 出席者（`attendees`）を省略した場合は自分だけを登録します。

### 予定の削除

```powershell
$headers["Idempotency-Key"] = "delete-20261120-001"
$body = @{ calendarId = "CALENDAR_ID"; eventId = "削除する予定ID" } | ConvertTo-Json
$job = Invoke-RestMethod -Method Post -Headers $headers -ContentType 'application/json' -Body $body http://127.0.0.1:3100/v1/events/delete
Invoke-RestMethod -Headers $headers "http://127.0.0.1:3100/v1/event-jobs/$($job.data.id)"
```

- 削除前に予定の存在と繰り返し設定を確認し、`DELETE` 受理後に再取得で消失を確認した場合だけ `deleted` にします。
- 繰り返し予定はAPI上で系列全体しか削除できないため、`allowSeries = $true` なしでは `SERIES_DELETE_REQUIRED`(409) で拒否します。
- 削除対象が見つからない場合は `failed / NOT_FOUND` です。

### 再送禁止ルール

再起動時、`creating` / `deleting` のジョブは `unknown`、`queued` / `validating` は `failed / INTERRUPTED` になります。**自動再送は行いません。** `unknown` はTimeTree上で確認し、台帳（`event_data/`）を削除したり新しいキーで再投稿しないでください。台帳を削除すると重複防止の記録も失われます。

## アカウント切り替え

複数のTimeTreeアカウントを使う場合は、アカウントごとに別プロファイル（`account2` など）で `pnpm sessions:export --name account2` を実行し、`settings.json` の `profiles` へ追加します。実ログインアカウントを照合して次の操作先を選択できます。詳細は [アカウント切り替え](docs/accounts.md) を参照してください。

```powershell
Invoke-RestMethod -Headers $headers http://127.0.0.1:3100/v1/accounts
$body = @{ profile = "account2"; expectedAccountId = 12345 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Headers $headers -ContentType 'application/json' -Body $body http://127.0.0.1:3100/v1/accounts/select
```

## MCP

HTTPモードのRelayをstdio MCPとして利用できます。予定の確認・追加・削除を自然言語から行えます。詳細は [MCP](docs/mcp.md) を参照してください。

## 検証コマンド

```powershell
pnpm type-check
pnpm test
pnpm build
pnpm lint
```

実TimeTreeへアクセスするsmoke testは通常のテストに含めません。ログイン済みセッションがある状態で、明示的に実行します。

```powershell
pnpm test:live
```

カレンダー一覧・予定一覧を読み、翌日のテスト予定を1件追加して読み戻し、削除して消失を確認します。

## セッション管理

[セッションCookie方式](docs/http-mode.md)では、認証情報をGit管理外のローカルファイルへ保存します。ファイルは600、保存ディレクトリは700を推奨します。認証値は応答・ログ・MCPへ含めません。

## ライセンス

MIT License。本プロジェクトの構造と実装方針は [shirafukayayoi/instagram_api_safe_relay](https://github.com/shirafukayayoi/instagram_api_safe_relay) を参考にしています。
