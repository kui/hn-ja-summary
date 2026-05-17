# AGENTS.md

## 実行環境

`deno` および `node` などのランタイムは mise
経由で管理されている。コマンドを実行する際は `mise exec -- deno ...` のように
mise 経由で実行すること（または `mise run` タスクを使う）。

`mise` が PATH にない場合はインストールすること: https://mise.jdx.dev/getting-started.html

## コミット前チェック

コードを変更したら、コミットする前に必ず以下をすべてパスさせること。
**フォーマット自動修正を先に実行してからチェックすること。**

### Deno (poller/, processor/, shared/, scripts/)

```bash
deno fmt <変更したファイル...>                  # フォーマット自動修正（必須）
deno check poller/main.ts processor/main.ts    # 型チェック
deno task lint                                 # lint + fmt --check
```

- `deno fmt <ファイル>`: 変更したファイルのフォーマットを自動修正する。**チェック前に必ず実行すること。**
- `.sql` ファイルを変更した場合は `deno task fmt:sql` でフォーマットすること（`deno task fmt:sql:check` は pre-commit hook に含まれる）
  - **注意**: Windows 環境（`core.autocrlf=true`）で `deno fmt`（引数なし）を実行すると、
    CRLF 差分が全ファイルで報告されるが、これは Windows 固有の問題で CI には影響しない。
    必ず **変更したファイルのみ** を引数に渡すこと。
- `deno check`: 型エラーがないこと
- `deno lint`: lint エラーがないこと
- `deno fmt --check`: フォーマットが揃っていること（`deno task lint` に含まれる）

### Worker (worker/)

```bash
npm --prefix worker run check
npm --prefix worker run lint
npm --prefix worker run fmt:check
```

- `check`: `tsc --noEmit` による型チェック
- `lint`: ESLint
- `fmt:check`: Prettier によるフォーマットチェック

フォーマットエラーは `npm --prefix worker run fmt` で自動修正できる。

## README の更新確認

コードや設定に変更を加えた際は、README.md の内容も更新が必要でないか必ず確認すること。

## フック有効化

リポジトリ初期化後に一度だけ実行:

```bash
git config core.hooksPath .githooks
```

## GitHub Actions ワークフローのトリガー

ワークフローを動かすためだけの空コミット（`git commit --allow-empty`）は行わないこと。
再デプロイが必要な場合は `gcloud run deploy` や `gcloud run jobs update` などの CLI コマンドで直接実行すること。

## スキル実行後の自己改善

`.claude/commands/` 配下のスキル（slash command）を実行した際は、完了時に必ずそのスキルプロンプトを振り返り、実行中に発見した問題点・不足・改善点があればプロンプトファイルを修正すること。
