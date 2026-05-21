# HN Summary Feed

HN トレンド記事を自動検出し、元記事とコメントを Gemini で日本語要約して RSS
配信するシステム。

- フィード配信 <https://hn-summary.k-ui.jp>
- 管理 UI <https://hn-feed-admin.k-ui.workers.dev>

## アーキテクチャ

詳しくは [architecture.mermaid](architecture.mermaid)

```
Cron Trigger (15分ごと)
  └─→ backend-worker (scheduled)
        ├─ Algolia HN API: 直近24時間・コメント10件以上のストーリーを取得
        ├─ velocity フィルタ
        ├─ D1: processed_items で重複チェック
        └─ CF Queue: 未処理を投入

CF Queues (hn-processor)
  └─→ backend-worker (queue)
        ├─ Algolia HN API: コメントツリー取得
        ├─ Jina + raw fetch: 元記事取得
        ├─ Gemini: 日本語要約生成
        └─ D1: feed_items / processed_items 更新

feed-worker (fetch handler)
  ├─ GET /feed.xml    → RSS (Inoreader で購読)
  └─ GET /items/{id} → 要約 HTML ページ

admin-worker (fetch handler, Cloudflare Access で保護)
  └─ GET, POST /enqueue → 投稿を手動でキューに追加
```

## ディレクトリ構成

```
shared/      共通型定義・HN API クライアント・フィルタ
backend/     scheduled (poller) + queue (processor) を担う Worker
feed/        RSS 配信・要約 HTML ページ配信 Worker
admin/       手動キュー投入 UI Worker（Cloudflare Access で保護）
migrations/  D1 共通マイグレーション
scripts/     GitHub Secrets 同期スクリプト
```

## 環境変数

### feed-worker / admin-worker

バインディングのみ。シークレット不要。

### backend-worker (wrangler secret で投入)

| 変数             | 説明            |
| ---------------- | --------------- |
| `GEMINI_API_KEY` | Gemini API キー |
| `JINA_API_KEY`   | Jina API キー   |

## セットアップ手順

`.env.example` をコピーして値を埋める。

```bash
cp .env.example .env
# .env を編集して各値を記入
```

GitHub Secrets への反映:

```bash
bash scripts/sync-github-env.sh
```

### 1. git フック有効化

```bash
git config core.hooksPath .githooks
```

### 2. 依存パッケージインストール

```bash
npm install
```

### 3. Cloudflare D1 データベース作成（初回のみ）

```bash
cd feed
npx wrangler d1 create hn-feed
```

出力された `database_id` を `feed/wrangler.toml` と `backend/wrangler.toml` の
両方に記入し、`CLOUDFLARE_D1_DATABASE_ID` を env に設定する。

```bash
npx wrangler d1 migrations apply hn-feed --remote
```

### 4. CF Queue 作成（初回のみ）

```bash
cd backend
npx wrangler queues create hn-processor
```

### 5. シークレット投入（backend-worker）

```bash
cd backend
wrangler secret put GEMINI_API_KEY
wrangler secret put JINA_API_KEY
```

### 6. Cloudflare Access の設定（admin-worker）

Cloudflare Zero Trust ダッシュボードで admin-worker の URL に対して Access Application を作成し、許可するメールアドレスを設定する。これにより admin-worker はアプリケーションコードに認証ロジックを持たずに保護される。

### 7. デプロイ

```bash
npm -w feed run deploy
npm -w backend run deploy
npm -w admin run deploy
```

### 8. Inoreader で RSS 購読

`https://hn-feed.<your-subdomain>.workers.dev/feed.xml` を Inoreader に登録。

## ローカル実行

```bash
# feed-worker
npm -w feed run dev

# backend-worker (scheduled を手動発火)
npm -w backend run dev:scheduled

# admin-worker
npm -w admin run dev
```

`wrangler tail -e production` でリアルタイムログ確認。

## 掲載条件

[`shared/filter.ts`](shared/filter.ts)
