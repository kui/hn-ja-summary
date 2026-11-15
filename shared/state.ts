import { Temporal } from "temporal-polyfill";

// enqueued: poller がキュー追加済み（リトライ中を含む）
// completed: processor が D1 への書き込みまで成功
// error: processor が処理失敗（次回 poller 実行時に再エンキュー）
// failed: error が MAX_ERRORS 回続いた。poller は再エンキューせず、admin からの手動投入だけ受け付ける
// skipped: processor が意図的にスキップ（HN アイテム消滅など）
export type ItemState =
  | "enqueued"
  | "completed"
  | "error"
  | "failed"
  | "skipped";

// 恒久的な失敗（SAFETY ブロックなど）でも poller は 30 分ごとに再投入するので、
// 失敗の種類によらず Gemini と Firecrawl の呼び出し回数に上限をかける
export const MAX_ERRORS = 3;

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

// resetErrorCount: admin からの手動投入で使う。failed の項目にもう一度 MAX_ERRORS 回の機会を与える
export async function setEnqueued(
  db: D1Database,
  id: number,
  { resetErrorCount = false }: { resetErrorCount?: boolean } = {},
): Promise<void> {
  const now = Temporal.Now.instant().epochMilliseconds;
  await db
    .prepare(
      `INSERT INTO processed_items (id, state, created_at_ms, enqueued_at_ms, updated_at_ms)
       VALUES (?, 'enqueued', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         state = 'enqueued',
         enqueued_at_ms = excluded.enqueued_at_ms,
         updated_at_ms = excluded.updated_at_ms,
         error_count = CASE WHEN ? THEN 0 ELSE error_count END`,
    )
    .bind(id, now, now, now, resetErrorCount ? 1 : 0)
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
         error_count = 0`,
    )
    .bind(id, now, now, now)
    .run();
}

export async function setError(
  db: D1Database,
  id: number,
  message: string,
): Promise<void> {
  const now = Temporal.Now.instant().epochMilliseconds;
  await db
    .prepare(
      `INSERT INTO processed_items (id, state, created_at_ms, error_message, updated_at_ms, error_count)
       VALUES (?1, 'error', ?3, ?4, ?3, 1)
       ON CONFLICT(id) DO UPDATE SET
         state = CASE WHEN error_count + 1 >= ?2 THEN 'failed' ELSE 'error' END,
         error_message = excluded.error_message,
         updated_at_ms = excluded.updated_at_ms,
         error_count = error_count + 1`,
    )
    .bind(id, MAX_ERRORS, now, message)
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
