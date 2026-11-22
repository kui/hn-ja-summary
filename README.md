# HN Summary Feed

HN トレンド記事を自動検出し、元記事とコメントを Gemini で日本語要約して RSS
配信するシステム。

- フィード配信 <https://hn-summary.k-ui.jp>
- 管理 UI <https://hn-feed-admin.k-ui.workers.dev>

## アーキテクチャ

詳しくは [architecture.mermaid](architecture.mermaid)

```
Cron Trigger
  └─→ backend-worker (scheduled)
        ├─ Algolia HN API: 最近のストーリーを取得
        ├─ velocity フィルタ
        ├─ D1: processed_items で重複チェック
        └─ CF Queue: 未処理を投入

CF Queues (hn-processor, 1 回の実行で 1 件)
  └─→ backend-worker (queue)
        ├─ Algolia HN API: コメントツリー取得 (dead なコメントの下の返信は検索で補う)
        ├─ raw fetch → Firecrawl → Wayback: 元記事取得
        ├─ Gemini (gemini-3.5-flash-lite, Flex 推論): 日本語要約を構造化出力 (JSON) で生成
        ├─ 検証して HTML を組み立て (失敗はキューで再試行)
        └─ D1: feed_items / processed_items 更新

CF Queues (hn-processor-dlq, 再試行を使い切ったメッセージ)
  └─→ backend-worker (queue): その項目を error にする

feed-worker (fetch handler)
  ├─ GET /feed.xml    → RSS (Inoreader で購読)
  └─ GET /items/{id} → 要約 HTML ページ

admin-worker (fetch handler, Cloudflare Access で保護)
  └─ GET, POST /enqueue → 投稿を手動でキューに追加
```

## ディレクトリ構成

```
shared/      共通型定義・HN API クライアント・フィルタ・処理状態の更新・HTML ユーティリティ
backend/     scheduled (poller) + queue (processor) を担う Worker
             (gemini.ts: モデル呼び出しと出力の変換、summary.ts: 要約 HTML の検証と組み立て)
feed/        RSS 配信・要約 HTML ページ配信 Worker
admin/       手動キュー投入 UI Worker（Cloudflare Access で保護）
migrations/  D1 共通マイグレーション
scripts/     開発用スクリプト
```

## 掲載条件

直近 24 時間に投稿されたストーリーのうち、次の 3 つをすべて満たすものを要約する。

- 投稿から 2 時間以上たっている
- コメントが 40 件以上ある
- 投稿からの平均で毎時 20 ポイント以上獲得している

## 開発

```bash
git config core.hooksPath .githooks
npm install
```

ローカル実行:

```bash
# feed-worker
npm -w feed run dev

# backend-worker (scheduled を手動発火)
npm -w backend run dev:scheduled

# admin-worker
npm -w admin run dev
```

## 開発・運用する人向けのドキュメント

- [初回構築](docs/setup.md)：D1・Queue・シークレット・Cloudflare Access の準備
- [デプロイ](docs/deployment.md)：デプロイの順序、手動での再デプロイ、失敗したときの対応
- [D1 マイグレーションと Queue メッセージの変更](docs/database-migrations.md)：新旧のバージョンが同時に動いても壊れない変更の進め方
- [運用](docs/operations.md)：ログ、Queue の再試行と DLQ、error になった項目の調べ方
