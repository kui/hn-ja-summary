# HN Summary Feed

HN トレンド記事を自動検出し、元記事とコメントを Gemini で日本語要約して RSS
配信するシステム。

- <https://hn-summary.k-ui.jp>

## アーキテクチャ

```
Cloud Scheduler (15分ごと)
  └─→ Cloud Run Job: poller/
        ├─ HN Firebase API: top 500件取得
        ├─ velocity フィルタ
        ├─ Firestore: 処理済みチェック
        └─ Cloud Tasks: 未処理を投入

Cloud Tasks
  └─→ Cloud Run Service: processor/
        ├─ 元記事 fetch
        ├─ Algolia HN API: コメントツリー
        ├─ Gemini 2.0 Flash: 日本語要約生成
        └─ Cloudflare Workers KV: feed + 個別ページ更新

Cloudflare Workers: worker/
  ├─ GET /feed.xml    → RSS (Inoreader で購読)
  └─ GET /items/{id} → 要約 HTML ページ
```

## ディレクトリ構成

```
shared/     Web 標準 API のみ使用する共通モジュール (型定義・RSS生成・GCP認証)
poller/     Cloud Run Job (Deno) — HN取得・フィルタ・Cloud Tasks投入
processor/  Cloud Run Service (Deno) — 要約生成・KV書き込み
worker/     Cloudflare Workers — RSS配信・要約HTMLページ配信
scripts/    GCPインフラ構築・デプロイ・GitHub Secrets同期スクリプト
```

## 環境変数

### poller (Cloud Run Job)

| 変数                         | 説明                                    |
| ---------------------------- | --------------------------------------- |
| `GCP_PROJECT_ID`             | GCP プロジェクト ID                     |
| `GCP_REGION`                 | リージョン (default: `asia-northeast1`) |
| `CLOUD_TASKS_QUEUE`          | キュー名 (default: `hn-processor`)      |
| `PROCESSOR_URL`              | Processor の Cloud Run URL              |
| `SERVICE_ACCOUNT_EMAIL`      | タスク投入用サービスアカウント          |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | ローカル実行時のみ (JSON文字列)         |

### processor (Cloud Run Service)

| 変数                         | 説明                                          |
| ---------------------------- | --------------------------------------------- |
| `GEMINI_API_KEY`             | Gemini API キー                               |
| `CLOUDFLARE_ACCOUNT_ID`      | Cloudflare アカウント ID                      |
| `CLOUDFLARE_KV_NAMESPACE_ID` | KV ネームスペース ID                          |
| `CLOUDFLARE_API_TOKEN`       | Cloudflare API トークン (KV 書き込み権限)     |
| `WORKERS_DOMAIN`             | Worker のドメイン (`hn-feed.xxx.workers.dev`) |
| `MAX_COMMENTS`               | 要約に使う抽出コメント最大数                  |
| `PORT`                       | HTTP ポート (default: `8080`)                 |

## セットアップ手順

`env.example` をコピーして値を埋める。Claude Code を使う場合は `/setup-env` コマンドで対話的に作成できる。

```bash
# Claude Code を使う場合
/setup-env

# 手動で作成する場合
cp env.example env
# env を編集して各値を記入
source env
```

GitHub Secrets/Variables への反映は `mise run sync-github` で行う（`gh` CLI
認証済みであること）。

### 1. GCP インフラ構築

```bash
bash scripts/setup.sh
```

### 2. Cloudflare KV ネームスペース作成

```bash
cd worker
npm install
npx wrangler kv namespace create "KV"
npx wrangler kv namespace create "KV" --preview
```

出力された ID を `wrangler.toml` に記入し、`WORKERS_DOMAIN` も設定する。

### 3. Processor デプロイ

```bash
bash scripts/deploy-processor.sh
```

### 4. Worker デプロイ

```bash
cd worker
npx wrangler deploy
```

### 5. Poller デプロイ (Cloud Run Job + Cloud Scheduler)

```bash
bash scripts/deploy-poller.sh
```

### 6. Inoreader で RSS 購読

`https://hn-feed.xxx.workers.dev/feed.xml` を Inoreader に登録。

## ローカル実行

`env` を `source` してから起動する。`GOOGLE_SERVICE_ACCOUNT_KEY`
はローカル実行時のみ必要（GCP メタデータサーバーが使えないため）。

Processor の動作確認:

```bash
source env
deno task processor

# 別ターミナルで動作確認
curl -X POST http://localhost:8080/process \
  -H "Content-Type: application/json" \
  -d '{"itemId": 43000000}'
```

Poller のローカル実行:

```bash
source env
deno task poller
```

## フィルタ条件

```
velocity = score / age_hours  >= 30 pt/h
AND (age >= 1h OR score >= 100 OR comments >= 50)
```

閾値は `poller/filter.ts` の定数で調整。
