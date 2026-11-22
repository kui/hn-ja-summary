# 初回構築

Cloudflare 上に D1・Queue・Worker を用意し、デプロイできる状態にするまでの手順。ローカルで開発するだけなら、README の「開発」の手順で足りる。

## 秘密情報

秘密情報はリポジトリの中（`.env` など）に置かない。ローカルの wrangler は各自のアカウントでログインして使う。

```bash
npx wrangler login
```

### feed-worker / admin-worker

バインディングのみ。シークレット不要。

### backend-worker（wrangler secret で投入）

| 変数                | 説明               |
| ------------------- | ------------------ |
| `GEMINI_API_KEY`    | Gemini API キー    |
| `FIRECRAWL_API_KEY` | Firecrawl API キー |

### GitHub Actions（Deploy ワークフロー）

| Secret                 | 説明                                                                  |
| ---------------------- | --------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN` | D1 マイグレーションと Worker のデプロイに使う Cloudflare API トークン |

## 1. Cloudflare D1 データベース作成

```bash
cd feed
npx wrangler d1 create hn-feed
```

出力された `database_id` を `feed/wrangler.toml` と `backend/wrangler.toml` の
両方に記入する。

リポジトリのルートでマイグレーションを適用する。

```bash
npm run db:migrate
```

## 2. CF Queue 作成

```bash
cd backend
npx wrangler queues create hn-processor
npx wrangler queues create hn-processor-dlq
```

## 3. シークレット投入（backend-worker）

```bash
cd backend
wrangler secret put GEMINI_API_KEY
wrangler secret put FIRECRAWL_API_KEY
```

Deploy ワークフロー用の Cloudflare API トークンを GitHub Secrets に登録する。値はプロンプトに貼り付け、ファイルやコマンドライン引数には書かない。

```bash
gh secret set CLOUDFLARE_API_TOKEN
```

## 4. Cloudflare Access の設定（admin-worker）

Cloudflare Zero Trust ダッシュボードで admin-worker の URL に対して Access Application を作成し、許可するメールアドレスを設定する。これにより admin-worker はアプリケーションコードに認証ロジックを持たずに保護される。

## 5. デプロイ

[デプロイ](deployment.md) の手順でデプロイする。

## 6. Inoreader で RSS 購読

`https://hn-feed.<your-subdomain>.workers.dev/feed.xml` を Inoreader に登録。
