# 運用

## ログ

`wrangler tail -e production` でリアルタイムログ確認。

## Queue の再試行と DLQ

processor（`hn-processor` の consumer）は失敗をその場で作り直さず、キューで遅延を倍々に延ばして再試行する（最大 6 回）。
Gemini がプロンプトを安全性フィルタで止めたときなど、再試行しても通らない失敗だけはすぐ `error` にする。

再試行を使い切ったメッセージは `hn-processor-dlq` に移り、backend-worker がその項目を `error` にする。
再試行の回数と間隔は `backend/wrangler.toml` で設定している。

## 処理を諦めた項目

`error` の項目は poller が再投入しない。再試行しても通らない失敗（Gemini がプロンプトを安全性フィルタで止めたときなど）か、
キューの再試行を使い切ったもの。`error_message` には、最後に再試行に回したときのエラーが残る。
次のコマンドで一覧を出し、原因を直したあとに管理 UI の「エンキュー」から投入し直す。

```bash
npm -w feed exec -- wrangler d1 execute hn-feed --remote --command "SELECT id, error_message FROM processed_items WHERE state = 'error' ORDER BY updated_at_ms DESC"
```

投入から 12 時間を過ぎても `enqueued` のままの項目は、メッセージが失われている。
管理 UI の「エンキュー」から投入し直せる。
