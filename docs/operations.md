# 運用

## ログ

`wrangler tail -e production` でリアルタイムログ確認。

## Queue の再試行と DLQ

processor（`hn-processor` の consumer）は失敗してもその場では再試行せず、キューで指数バックオフをかけて再試行する。
Gemini がプロンプトを安全性フィルタで止めたときなど、再試行しても成功しない失敗だけはすぐ `error` にする。

再試行を使い切ったメッセージは `hn-processor-dlq` に移り、backend-worker がその項目を `error` にする。
再試行の回数（`max_retries`）は `backend/wrangler.toml` で設定している。

## error になった項目

`error` の項目は poller が再投入しない。再試行しても成功しない失敗（Gemini がプロンプトを安全性フィルタで止めたときなど）か、
キューの再試行を使い切ったもの。`error_message` に残るのは、最後に再試行へ回したときのエラー。
管理 UI の「エンキュー」のタスク一覧を `error` で絞り込むと、項目と `error_message` を一覧できる。
原因を直したあと、その行の「再投入」ボタンを押す。

投入から 12 時間を過ぎても `enqueued` のままの項目は、メッセージが失われている。
管理 UI の「エンキュー」から再投入できる。
