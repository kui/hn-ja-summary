import { escapeHtml } from "@hn-feed/shared/html";
import { ITEM_STATES, type ItemState } from "@hn-feed/shared/state";
import { Temporal } from "temporal-polyfill";

export const PAGE_SIZE = 50;

interface Cursor {
  updatedAtMs: number;
  id: number;
}

// OFFSET は飛ばす行も D1 で読まれて課金されるので、直前のページの端の行を起点にする
type Page =
  | { kind: "first" }
  | { kind: "older"; cursor: Cursor }
  | { kind: "newer"; cursor: Cursor };

export interface ListQuery {
  state: ItemState | null;
  page: Page;
}

interface TaskRow {
  id: number;
  state: ItemState;
  updated_at_ms: number;
  error_message: string | null;
  skip_reason: string | null;
  title: string | null;
}

export function parseState(value: unknown): ItemState | null {
  return ITEM_STATES.find((s) => s === value) ?? null;
}

function parseCursor(text: string | null): Cursor | null {
  const m = /^(0|[1-9][0-9]*)_([1-9][0-9]*)$/.exec(text ?? "");
  if (!m) return null;
  const updatedAtMs = Number(m[1]);
  const id = Number(m[2]);
  if (!Number.isSafeInteger(updatedAtMs) || !Number.isSafeInteger(id))
    return null;
  return { updatedAtMs, id };
}

function formatCursor(row: TaskRow): string {
  return `${row.updated_at_ms}_${row.id}`;
}

// 不正な値は入力ミスなので、エラーにせず最初のページを出す
export function parseListQuery(params: URLSearchParams): ListQuery {
  const state = parseState(params.get("state"));
  const older = parseCursor(params.get("older"));
  if (older) return { state, page: { kind: "older", cursor: older } };
  const newer = parseCursor(params.get("newer"));
  if (newer) return { state, page: { kind: "newer", cursor: newer } };
  return { state, page: { kind: "first" } };
}

async function queryTasks(
  db: D1Database,
  { state, page }: ListQuery,
): Promise<{ rows: TaskRow[]; hasOlder: boolean; hasNewer: boolean }> {
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (state !== null) {
    where.push("p.state = ?");
    binds.push(state);
  }
  if (page.kind !== "first") {
    where.push(
      page.kind === "older"
        ? "(p.updated_at_ms, p.id) < (?, ?)"
        : "(p.updated_at_ms, p.id) > (?, ?)",
    );
    binds.push(page.cursor.updatedAtMs, page.cursor.id);
  }
  // 新しい側のページは起点に近い行から読み、あとで並べ直す
  const order = page.kind === "newer" ? "ASC" : "DESC";
  const { results } = await db
    .prepare(
      `SELECT p.id, p.state, p.updated_at_ms, p.error_message, p.skip_reason, f.title
       FROM processed_items p LEFT JOIN feed_items f ON f.id = p.id
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY p.updated_at_ms ${order}, p.id ${order}
       LIMIT ?`,
    )
    .bind(...binds, PAGE_SIZE + 1)
    .all<TaskRow>();

  const hasMore = results.length > PAGE_SIZE;
  const rows = results.slice(0, PAGE_SIZE);
  if (page.kind === "newer") rows.reverse();
  return {
    rows,
    // 起点の行より向こう側にも行があるとみなす。絞り込み中に行の状態が変わって外れると
    // 実際には 0 件のこともあるので、空のページには最初のページへのリンクを出す
    hasOlder: page.kind === "newer" ? true : hasMore,
    hasNewer:
      page.kind === "first" ? false : page.kind === "newer" ? hasMore : true,
  };
}

function listUrl(state: ItemState | null, extra: Record<string, string> = {}) {
  const params = new URLSearchParams(extra);
  if (state !== null) params.set("state", state);
  const qs = params.toString();
  return qs ? `/enqueue?${qs}` : "/enqueue";
}

function formatJst(epochMs: number): string {
  return Temporal.Instant.fromEpochMilliseconds(epochMs)
    .toZonedDateTimeISO("Asia/Tokyo")
    .toPlainDateTime()
    .toString({ smallestUnit: "minute" })
    .replace("T", " ");
}

function renderFilter(current: ItemState | null): string {
  const links = [null, ...ITEM_STATES].map((s) => {
    const label = s ?? "すべて";
    const attr = s === current ? ` aria-current="page"` : "";
    return `<a href="${escapeHtml(listUrl(s))}"${attr}>${label}</a>`;
  });
  return `<nav class="filter" aria-label="状態で絞り込む">${links.join(" ｜ ")}</nav>`;
}

function renderRow(row: TaskRow, state: ItemState | null): string {
  const hnUrl = `https://news.ycombinator.com/item?id=${row.id}`;
  const reason = row.error_message ?? row.skip_reason ?? "";
  const stateInput =
    state !== null
      ? `<input type="hidden" name="state" value="${escapeHtml(state)}">`
      : "";
  const action =
    row.state === "error"
      ? `<form method="POST" action="/enqueue"><input type="hidden" name="id" value="${row.id}">${stateInput}<button type="submit">再投入</button></form>`
      : "";
  return `<tr>
      <td><a href="${escapeHtml(hnUrl)}">${row.id}</a></td>
      <td class="state-${escapeHtml(row.state)}">${escapeHtml(row.state)}</td>
      <td>${escapeHtml(row.title ?? "")}</td>
      <td class="nowrap">${formatJst(row.updated_at_ms)}</td>
      <td class="reason">${escapeHtml(reason)}</td>
      <td>${action}</td>
    </tr>`;
}

export async function renderTaskList(
  db: D1Database,
  query: ListQuery,
): Promise<string> {
  const { rows, hasOlder, hasNewer } = await queryTasks(db, query);
  const first = rows[0];
  const last = rows.at(-1);
  const pager = [
    rows.length === 0 && query.page.kind !== "first"
      ? `<a href="${escapeHtml(listUrl(query.state))}" rel="prev">← 最初のページへ</a>`
      : "",
    hasNewer && first
      ? `<a href="${escapeHtml(listUrl(query.state, { newer: formatCursor(first) }))}" rel="prev">← 前へ</a>`
      : "",
    hasOlder && last
      ? `<a href="${escapeHtml(listUrl(query.state, { older: formatCursor(last) }))}" rel="next">次へ →</a>`
      : "",
  ].join(" ");

  const body =
    rows.length === 0
      ? `<p>該当するタスクはありません。</p>`
      : `<div class="table-wrap"><table>
    <thead><tr><th>ID</th><th>状態</th><th>タイトル</th><th>更新日時 (JST)</th><th>理由</th><th></th></tr></thead>
    <tbody>${rows.map((r) => renderRow(r, query.state)).join("")}</tbody>
  </table></div>`;

  return `<h2>タスク一覧</h2>
  ${renderFilter(query.state)}
  ${body}
  <nav class="pager" aria-label="ページ">${pager}</nav>`;
}
