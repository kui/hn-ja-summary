# AGENTS.md

## 設計の前提

このサービスは情報の鮮度を重視する。仕様を決めるときは、遅れて届く要約より、届かない要約を選ぶ。

- 時間がたった項目は、処理し直すより捨てる（例：再配信を使い切って止まった項目は、投入し直さず skipped にした）
- 再試行は、鮮度が保たれる時間の範囲に収める

## 実行環境

Node.js + npm workspaces で管理されている。ルートで `npm install` を実行すると
`feed/`, `backend/`, `shared/` のパッケージが一括インストールされる。

個別ワークスペースのみ確認したい場合は `npm run ts:check -w feed` などをルートから実行する。テストファイルと `vitest.config.ts` も、各ワークスペースの `tsconfig.test.json` でチェックされる。

## 依存ソフトウェアのバージョン選定

新しく導入する GitHub Actions・npm パッケージ・mise ツールなどのバージョンは、記憶や推測で書かないこと。
必ず最新版を確認する（例: `gh api repos/<owner>/<repo>/releases/latest`、`npm view <pkg> version`）。意図的に古いバージョンを使う場合のみ、その理由をコミットメッセージか
コメントで明示すること。

## PR の言語

PR のタイトルと説明文は日本語で書くこと。コミットメッセージは既存の履歴に合わせて英語のまま。

## ドキュメントの更新確認

コードや設定に変更を加えた際は、README.md と `docs/` の内容も更新が必要でないか必ず確認すること。
README.md はプロジェクトに興味を持った人が読む場所なので、開発・運用の手順や仕様は `docs/` に書く。

D1 のスキーマや Queue のメッセージ形式を変えるときは、[docs/database-migrations.md](docs/database-migrations.md) に従うこと。

## GitHub Actions ワークフローのトリガー

ワークフローを動かすためだけの空コミット（`git commit --allow-empty`）は行わないこと。
再デプロイが必要な場合は `gh workflow run deploy.yml --ref production` で Deploy ワークフローを手動実行すること。
`wrangler deploy` をローカルから実行しない（デプロイ用のトークンは GitHub Secrets にだけ置いている）。

## 秘密情報の扱い

秘密情報をリポジトリの中（`.env` など）に置かないこと。wrangler の認証は各自の `wrangler login` を使う。
`~/.wrangler` など認証情報の保存場所を読んだり、トークンを表示するコマンドを実行したりしないこと。

Gemini や Firecrawl を実際に呼んで挙動を確かめるスクリプトは、API キーをリポジトリの外のファイルから読むこと。
置き場所は `~/.config/hn-ja-summary/gemini-api-key` と `~/.config/hn-ja-summary/firecrawl-api-key`。
キーは画面とログに出さず、ファイルがなければ置き場所を示して止まること。ファイルはユーザーが確認するあいだだけ置く。
エージェントはこのファイルを作ったり、中身を表示したりしないこと。

## eslint-disable コメント

`eslint-disable` / `eslint-disable-next-line` を使う際は、必ず直前の行に **なぜ無効化するのか** を説明するコメントを書くこと。

```ts
// RFC 822 形式は Temporal に相当するAPIがないため Date を例外使用
// eslint-disable-next-line no-restricted-globals, no-restricted-syntax
return new Date(epochMs).toUTCString();
```

## 変更後のチェック

コードや設定を変更したら、必ず最後に以下を実行してすべてグリーンになることを確認すること。

```sh
npm run checkAll && npm test
```

## スキル実行後の自己改善

`.claude/commands/` 配下のスキル（slash command）を実行した際は、完了時に必ずそのスキルプロンプトを振り返ること。
実行中に発見した問題点・不足・改善点があれば、プロンプトファイルを修正する。
