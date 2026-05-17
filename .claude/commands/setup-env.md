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
5. サービスアカウント `hn-processor@<PROJECT_ID>.iam.gserviceaccount.com` が存在するか確認。なければ作成
6. サービスアカウントのメールアドレスを `GCP_SERVICE_ACCOUNT` に設定
7. **IAM & 管理 → IAM** でサービスアカウントに以下の **6つのロール** を付与する:
   - Artifact Registry 管理者
   - Cloud Run 管理者
   - Cloud Run 起動元
   - Cloud Scheduler 管理者（poller を定期実行するための Scheduler ジョブ作成に必須）
   - クラウドタスクへのデータ追加（Cloud Tasks エンキューアー）
   - サービス アカウント ユーザー（`iam.serviceaccounts.actAs` 権限。Cloud Run デプロイ時に必須）

### ステップ 3.5: Google Cloud — Artifact Registry

1. `https://console.cloud.google.com/artifacts?project=<PROJECT_ID>` を開く
2. **リポジトリを作成** をクリック
3. 以下の設定で作成:
   - 名前: `gcr.io`
   - 形式: **Docker**
   - リージョン: **マルチリージョン → us**
4. ⚠️ このリポジトリが存在しないと、GitHub Actions から `docker push gcr.io/<PROJECT_ID>/...` した際に `createOnPush` 権限エラーが発生する。必ずデプロイ前に作成すること

### ステップ 4: Google Cloud — Workload Identity

1. `https://console.cloud.google.com/iam-admin/workload-identity-pools?project=<PROJECT_ID>` を開く（プロジェクトを URL に含めないとプロジェクト未選択になることがある）
2. 既存のプールがあればそれを使用、なければ **プールを作成** → 名前 `github-actions`
3. プロバイダーを追加（OIDC、発行元 `https://token.actions.githubusercontent.com`）
4. 属性マッピング: `google.subject` → `assertion.sub`
5. 属性条件（必須）: `assertion.sub != ""` を設定する。GCP はデプロイパイプライン用 OIDC プロバイダーに属性条件を要求するため、省略するとエラーになる
6. プロバイダーのリソース名（`projects/<NUMBER>/locations/global/workloadIdentityPools/<POOL>/providers/<PROVIDER>` 形式）を `GCP_WORKLOAD_IDENTITY_PROVIDER` に設定

### ステップ 5: Gemini API Key

1. `https://aistudio.google.com/app/apikey` を開く
2. **Create API key** をクリックしてキーを取得
3. `GEMINI_API_KEY` に設定

### ステップ 6: Jina API Key

1. `https://jina.ai/` を開く（ログイ���済みであればトップページ下部に API キーが表示される）
2. ページ内の「APIキー」テキストボックスからキーをコピー
3. `JINA_API_KEY` に��定

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
bash scripts/sync-github-env.sh
```

を実行して GitHub Secrets/Variables に同期する（`mise` がインストール済みなら `mise run sync-github` でも可）。

## ダイジェスト出力

すべての手順が完了したら、今回行った操作のダイジェストを出力する。各ステップで取得・設定した値（トークンやキーはマスクせず表示）、スキップした項目、発生したエラーと対処を簡潔にまとめること。
