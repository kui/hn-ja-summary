# setup-env

Browser MCP を使って各サービスの認証情報を取得し、プロジェクトルートの `env` ファイルに書き込む。

## 前提

- Browser MCP が利用可能なこと（Windowsホスト側で実行すること）
- `env` ファイルが存在しない場合は新規作成する

## 手順

以下を順に実行し、取得した値を `env` ファイルの該当行に書き込む。
書き込む際は `env.example` のフォーマットに従い、既存の値は上書きしない（空の場合のみ設定する）。

---

### ステップ 1: Cloudflare — Account ID & API Token

1. `https://dash.cloudflare.com/` を開く
2. ログイン済みであることを確認する（未ログインなら待機してユーザーにログインを促す）
3. ダッシュボード右サイドバーの **Account ID** をコピーして `CLOUDFLARE_ACCOUNT_ID` に設定
4. `https://dash.cloudflare.com/profile/api-tokens` を開く
5. **Create Token** → **Edit Cloudflare Workers** テンプレートを選択（または Custom Token で Workers KV Storage: Edit 権限を付与）
6. トークンを作成してコピーし `CLOUDFLARE_API_TOKEN` に設定

### ステップ 2: Cloudflare — KV Namespace

1. `https://dash.cloudflare.com/` を開き、左メニューから **Workers & Pages → KV** へ移動
2. **Create a namespace** をクリックし、名前 `hn-feed` で作成
3. 作成された Namespace の ID をコピーして `CLOUDFLARE_KV_NAMESPACE_ID` に設定
4. また `worker/wrangler.toml` の `id` と `preview_id` にも同じ値を書き込む（preview_id はもう一つ別の namespace `hn-feed-preview` を作成して設定）

### ステップ 3: Google Cloud — Project ID & Service Account

1. `https://console.cloud.google.com/` を開く
2. ログイン済みであることを確認する
3. プロジェクト選択ドロップダウンから対象プロジェクトを選択し、**プロジェクト ID** をコピーして `GCP_PROJECT_ID` に設定
4. 左メニュー **IAM & 管理 → サービスアカウント** へ移動
5. サービスアカウント `hn-processor@<PROJECT_ID>.iam.gserviceaccount.com` が存在するか確認。なければ作成（ロール: Cloud Tasks エンキューアー、Cloud Run 起動元）
6. サービスアカウントのメールアドレスを `GCP_SERVICE_ACCOUNT` に設定

### ステップ 4: Google Cloud — Workload Identity

1. `https://console.cloud.google.com/iam-admin/workload-identity-pools` を開く
2. 既存のプールがあればそれを使用、なければ **プールを作成** → 名前 `github-actions`
3. プロバイダーを追加（OIDC、発行元 `https://token.actions.githubusercontent.com`）
4. プロバイダーのリソース名（`projects/<NUMBER>/locations/global/workloadIdentityPools/<POOL>/providers/<PROVIDER>` 形式）を `GCP_WORKLOAD_IDENTITY_PROVIDER` に設定

### ステップ 5: Gemini API Key

1. `https://aistudio.google.com/app/apikey` を開く
2. **Create API key** をクリックしてキーを取得
3. `GEMINI_API_KEY` に設定

### ステップ 6: Jina API Key

1. `https://jina.ai/` を開き、ログインまたはアカウント作成
2. API Keys ページへ移動してキーをコピー
3. `JINA_API_KEY` に設定

---

## env ファイルへの書き込み

すべての値が取得できたら、プロジェクトルートの `env` ファイルに以下のフォーマットで書き込む:

```
# --- GitHub Secrets (sensitive) ---
CLOUDFLARE_API_TOKEN=<value>
CLOUDFLARE_ACCOUNT_ID=<value>
CLOUDFLARE_KV_NAMESPACE_ID=<value>
GCP_PROJECT_ID=<value>
GCP_WORKLOAD_IDENTITY_PROVIDER=<value>
GCP_SERVICE_ACCOUNT=<value>
PROCESSOR_URL=
GEMINI_API_KEY=<value>
JINA_API_KEY=<value>

# --- GitHub Variables (non-sensitive config) ---
GCP_REGION=asia-northeast1
CLOUD_TASKS_QUEUE=hn-processor
WORKERS_DOMAIN=
MAX_COMMENTS=20
```

`PROCESSOR_URL` と `WORKERS_DOMAIN` は Cloud Run / Workers のデプロイ後に設定するため空のままにする。

## 完了後

```bash
mise run sync-github
```

を実行して GitHub Secrets/Variables に同期する。
