// enqueued: poller がキュー追加済み（リトライ中を含む）
// completed: processor が D1 への書き込みまで成功
// error: processor が処理失敗（次回 poller 実行時に再エンキュー）
// skipped: processor が意図的にスキップ（HN アイテム消滅など）
export type ItemState = "enqueued" | "completed" | "error" | "skipped";

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

export async function setEnqueued(db: D1Database, id: number): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO processed_items (id, state, created_at_ms, enqueued_at_ms, updated_at_ms)
       VALUES (?, 'enqueued', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = 'enqueued',
         enqueued_at_ms = excluded.enqueued_at_ms,
         updated_at_ms = excluded.updated_at_ms`,
    )
    .bind(id, now, now, now)
    .run();
}

export async function setCompleted(db: D1Database, id: number): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO processed_items (id, state, created_at_ms, completed_at_ms, updated_at_ms)
       VALUES (?, 'completed', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = 'completed',
         completed_at_ms = excluded.completed_at_ms,
         updated_at_ms = excluded.updated_at_ms`,
    )
    .bind(id, now, now, now)
    .run();
}

export async function setError(
  db: D1Database,
  id: number,
  message: string,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO processed_items (id, state, created_at_ms, error_message, updated_at_ms)
       VALUES (?, 'error', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = 'error',
         error_message = excluded.error_message,
         updated_at_ms = excluded.updated_at_ms`,
    )
    .bind(id, now, message, now)
    .run();
}

export async function setSkipped(
  db: D1Database,
  id: number,
  reason: string,
): Promise<void> {
  const now = Date.now();
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
