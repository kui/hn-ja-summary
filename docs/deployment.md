# デプロイ

`production` ブランチへの push で GitHub Actions（`.github/workflows/deploy.yml`）が
CI → D1 マイグレーション → 3 Worker のデプロイの順に実行する。CI が失敗したら
マイグレーションもデプロイも実行しない。

マイグレーションの適用から Worker のデプロイ完了までは、古いコードが新しいスキーマの上で動く。
マイグレーションの書き方は [D1 マイグレーションと Queue メッセージの変更](database-migrations.md) に従う。

## 手動での再デプロイ

push せずに再デプロイするときは、Deploy ワークフローを手動実行する。push のときと同じく CI → マイグレーション → デプロイの順に実行する。`production` 以外のブランチを指定したときは何も実行しない。

```bash
gh workflow run deploy.yml --ref production
```

## 失敗したとき

デプロイが途中で失敗したときは、失敗した場所に応じて次のようにする。

- `ci`：何も変わっていないので、直して push する。
- `migrate`：Worker は古いまま。途中まで当たっている可能性があるのでログを確認し、直して push する。
- `deploy` の一部（`deploy (feed)` などワークスペースごとのジョブ）：残りの Worker は新しい版になっている。最新の run なら「Re-run failed jobs」で失敗したジョブだけ再実行する。新しい push のデプロイが済んでいれば何もしない。
- すべて成功したあとに不具合が見つかったとき：修正か revert を push する。スキーマは戻らない。

古い run を再実行すると、その時点のコードがデプロイされるので、最新の run 以外は再実行しない。
