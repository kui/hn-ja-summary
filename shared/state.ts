import { Temporal } from "temporal-polyfill";

// enqueued: poller がキュー追加済み（リトライ中を含む）。error_message には再試行に回した最後のエラーを残す
// completed: processor が D1 への書き込みまで成功
// error: 再試行しても通らない失敗か、Queue の再配信を使い切った。poller は再エンキューせず、admin から手動で投入し直す
// skipped: processor が意図的にスキップ（HN アイテム消滅など）
export const ITEM_STATES = [
  "enqueued",
  "completed",
  "error",
  "skipped",
] as const;
export type ItemState = (typeof ITEM_STATES)[number];

export async function batchGetStates(
  db: D1Database,
  ids: number[],
): Promise<Map<number, ItemState>> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT id, state FROM processed_items WHERE id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<{ id: number; state: ItemState }>();
  return new Map(results.map((r) => [r.id, r.state]));
}

// Queue に送ってから呼ぶ。先に書くと、送信に失敗したとき誰も拾わない enqueued が残る。
// 送ったあとに processor が先に結果を書いていたら（sentAtMs 以降に更新されていたら）上書きしない
export async function setEnqueued(
  db: D1Database,
  id: number,
  sentAtMs: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO processed_items (id, state, created_at_ms, enqueued_at_ms, updated_at_ms)
       VALUES (?1, 'enqueued', ?2, ?2, ?2)
       ON CONFLICT(id) DO UPDATE SET
         state = 'enqueued',
         enqueued_at_ms = excluded.enqueued_at_ms,
         updated_at_ms = excluded.updated_at_ms,
         error_message = NULL
       WHERE updated_at_ms < ?2`,
    )
    .bind(id, sentAtMs)
    .run();
}

export async function setCompleted(db: D1Database, id: number): Promise<void> {
  const now = Temporal.Now.instant().epochMilliseconds;
  await db
    .prepare(
      `INSERT INTO processed_items (id, state, created_at_ms, completed_at_ms, updated_at_ms)
       VALUES (?, 'completed', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = 'completed',
         completed_at_ms = excluded.completed_at_ms,
         updated_at_ms = excluded.updated_at_ms,
         error_message = NULL`,
    )
    .bind(id, now, now, now)
    .run();
}

// 同じ項目のメッセージが 2 つ Queue にあると、片方が終えた completed などをもう片方の失敗が
// 上書きしうるので、enqueued の行だけを error にする
export async function setError(
  db: D1Database,
  id: number,
  message: string,
): Promise<void> {
  const now = Temporal.Now.instant().epochMilliseconds;
  await db
    .prepare(
      `INSERT INTO processed_items (id, state, created_at_ms, error_message, updated_at_ms)
       VALUES (?, 'error', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = 'error',
         error_message = excluded.error_message,
         updated_at_ms = excluded.updated_at_ms
       WHERE state = 'enqueued'`,
    )
    .bind(id, now, message, now)
    .run();
}

// 再配信を使い切ったときに使う。最後の原因は setLastError で残っているので上書きしない。
// 15 分の上限で打ち切られた配信は catch を通らないので、残っていないこともある
export async function setRetriesExhausted(
  db: D1Database,
  id: number,
  fallbackMessage: string,
): Promise<void> {
  const now = Temporal.Now.instant().epochMilliseconds;
  await db
    .prepare(
      `INSERT INTO processed_items (id, state, created_at_ms, error_message, updated_at_ms)
       VALUES (?, 'error', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = 'error',
         error_message = COALESCE(error_message, excluded.error_message),
         updated_at_ms = excluded.updated_at_ms
       WHERE state = 'enqueued'`,
    )
    .bind(id, now, fallbackMessage, now)
    .run();
}

// 再試行に回すエラーを残す。状態は enqueued のまま変えない
export async function setLastError(
  db: D1Database,
  id: number,
  message: string,
): Promise<void> {
  const now = Temporal.Now.instant().epochMilliseconds;
  await db
    .prepare(
      `UPDATE processed_items SET error_message = ?, updated_at_ms = ?
       WHERE id = ? AND state = 'enqueued'`,
    )
    .bind(message, now, id)
    .run();
}

export async function setSkipped(
  db: D1Database,
  id: number,
  reason: string,
): Promise<void> {
  const now = Temporal.Now.instant().epochMilliseconds;
  await db
    .prepare(
      `INSERT INTO processed_items (id, state, created_at_ms, skip_reason, updated_at_ms)
       VALUES (?, 'skipped', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = 'skipped',
         skip_reason = excluded.skip_reason,
         updated_at_ms = excluded.updated_at_ms`,
    )
    .bind(id, now, reason, now)
    .run();
}
