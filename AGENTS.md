# AGENTS.md

## 実行環境

`deno` および `node` などのランタイムは mise
経由で管理されている。コマンドを実行する際は `mise exec -- deno ...` のように
mise 経由で実行すること（または `mise run` タスクを使う）。

## コミット前チェック

コードを変更したら、コミットする前に必ず以下をすべてパスさせること:

### Deno (poller/, processor/, shared/)

```bash
deno check poller/main.ts processor/main.ts
deno task lint
```

- `deno check`: 型エラーがないこと
- `deno lint`: lint エラーがないこと
- `deno fmt --check`: フォーマットが揃っていること（`deno task lint`
  に含まれる）

フォーマットエラーは `deno fmt` で自動修正できる。

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
