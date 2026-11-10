# アカウント切り替え

TimeTreeアカウントごとに別のHTTPプロファイルを登録し、実ログインアカウントを照合して次の操作先を選択できます。

## 別アカウントの登録

1. 別プロファイル名でセッションをエクスポートします。

```powershell
pnpm sessions:export --name account2
```

2. `settings.json` の `profiles` へ追加します。セッションファイルのパスはRelayの作業ディレクトリ（`packages/server/`）が基準です。

```json
"profiles": [
	{ "name": "account1", "home": "https://timetreeapp.com/", "browser": { "type": "http", "sessionFile": "../../private_sessions/account1.json" } },
	{ "name": "account2", "home": "https://timetreeapp.com/", "browser": { "type": "http", "sessionFile": "../../private_sessions/account2.json" } }
]
```

3. 処理中のジョブがないことを確認してRelayを再起動します。

## 選択API

Bearer認証が必要です。応答には設定ラベル、状態、アカウントID・名前と選択中の操作先だけを含み、認証値は含めません。

- `GET /v1/accounts`：登録一覧と `selected` を返します。
- `POST /v1/accounts/select`：`{"profile":"account2","expectedAccountId":12345}` で選択します。`GET /user` の実アカウントと照合してから選択を確定します。未ログイン・別アカウント・保存失敗では選択を確定しません。

選択記録は `accounts.accountSelectionFile`（既定 `../../work/skill-relay/selected-account.json`）へ保存し、再起動後も復元します。保存先のプロファイルが設定から消えた場合は、別アカウントへ自動で切り替えません。

## 操作先の扱い

- 複数プロファイルでは、カレンダー・予定・ジョブAPIに `x-profile-name` が必須です。単一プロファイルは自動選択されます。
- 選択は新規ジョブの既定プロファイルです。受理済みジョブは元のプロファイルを維持します。
- 処理中・結果不明のジョブは元のプロファイルに固定し、切り替えによる再送は行いません。
