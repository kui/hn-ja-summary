# AGENTS.md

## 実行環境

Node.js + npm workspaces で管理されている。ルートで `npm install` を実行すると
`feed/`, `backend/`, `shared/` のパッケージが一括インストールされる。

## コミット前チェック

コードを変更したら、コミットする前に必ず以下をすべてパスさせること。
**フォーマット自動修正を先に実行してからチェックすること。**

```bash
# フォーマット自動修正（必須）
npm run fmt

# 型チェック・lint・フォーマットチェック
npm run fmt:check
npm run check
npm run lint
```

- `fmt` / `fmt:check`: Markdown・SQL・全ワークスペースの src をまとめて処理
- `check`: 全ワークスペースの `tsc --noEmit`
- `lint`: 全ワークスペースの ESLint

個別ワークスペースのみ確認したい場合は `tsc -p feed/tsconfig.json --noEmit` などをルートから実行する。

## 依存ソフトウェアのバージョン選定

新しく導入する GitHub Actions・npm パッケージ・mise ツールなどのバージョンを指定する際は、
記憶や推測で書かず必ず最新版を確認すること（例: `gh api repos/<owner>/<repo>/releases/latest`、
`npm view <pkg> version`）。意図的に古いバージョンを使う場合のみ、その理由をコミットメッセージか
コメントで明示すること。

## README の更新確認

コードや設定に変更を加えた際は、README.md の内容も更新が必要でないか必ず確認すること。

## フック有効化

リポジトリ初期化後に一度だけ実行:

```bash
git config core.hooksPath .githooks
```

## GitHub Actions ワークフローのトリガー

ワークフローを動かすためだけの空コミット（`git commit --allow-empty`）は行わないこと。
再デプロイが必要な場合は `wrangler deploy` コマンドで直接実行すること。

## スキル実行後の自己改善

`.claude/commands/` 配下のスキル（slash command）を実行した際は、完了時に必ずそのスキルプロンプトを振り返り、実行中に発見した問題点・不足・改善点があればプロンプトファイルを修正すること。
