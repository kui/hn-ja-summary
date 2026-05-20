# AGENTS.md

## 実行環境

Node.js + npm workspaces で管理されている。ルートで `npm install` を実行すると
`feed/`, `backend/`, `shared/` のパッケージが一括インストールされる。

個別ワークスペースのみ確認したい場合は `tsc -p feed/tsconfig.json --noEmit` などをルートから実行する。

## 依存ソフトウェアのバージョン選定

新しく導入する GitHub Actions・npm パッケージ・mise ツールなどのバージョンを指定する際は、
記憶や推測で書かず必ず最新版を確認すること（例: `gh api repos/<owner>/<repo>/releases/latest`、
`npm view <pkg> version`）。意図的に古いバージョンを使う場合のみ、その理由をコミットメッセージか
コメントで明示すること。

## README の更新確認

コードや設定に変更を加えた際は、README.md の内容も更新が必要でないか必ず確認すること。

## GitHub Actions ワークフローのトリガー

ワークフローを動かすためだけの空コミット（`git commit --allow-empty`）は行わないこと。
再デプロイが必要な場合は `wrangler deploy` コマンドで直接実行すること。

## eslint-disable コメント

`eslint-disable` / `eslint-disable-next-line` を使う際は、必ず直前の行に **なぜ無効化するのか** を説明するコメントを書くこと。

```ts
// RFC 822 形式は Temporal に相当するAPIがないため Date を例外使用
// eslint-disable-next-line no-restricted-globals, no-restricted-syntax
return new Date(epochMs).toUTCString();
```

## スキル実行後の自己改善

`.claude/commands/` 配下のスキル（slash command）を実行した際は、完了時に必ずそのスキルプロンプトを振り返り、実行中に発見した問題点・不足・改善点があればプロンプトファイルを修正すること。
