import { escapeHtml } from "@hn-feed/shared/html";
import { Temporal } from "temporal-polyfill";
import { setEnqueued, type ItemState } from "@hn-feed/shared/state";
import {
  parseListQuery,
  parseState,
  renderTaskList,
  type ListQuery,
} from "./task-list.ts";

const PAGE_STYLE = `
:root{color-scheme:light dark;--text:#222;--bg:#fafafa;--input-border:#767676;--ok-bg:#e8f5e9;--ok-border:#a5d6a7;--warn-bg:#fff8e1;--warn-border:#ffe082;--error-bg:#ffebee;--error-border:#ef9a9a}
@media (prefers-color-scheme:dark){:root{--text:#e6e6e6;--bg:#161616;--input-border:#8a8a8a;--ok-bg:#1b3320;--ok-border:#2e7d32;--warn-bg:#3a2f0b;--warn-border:#8d6e00;--error-bg:#3b1a1a;--error-border:#c62828}}
body{max-width:720px;margin:0 auto;padding:16px;font-family:system-ui,sans-serif;line-height:1.6;color:var(--text);background:var(--bg)}
h1{font-size:1.5em;margin:.67em 0}
input[type=text]{width:100%;max-width:480px;padding:8px;font:inherit;border:1px solid var(--input-border);border-radius:4px;box-sizing:border-box}
button{margin-top:8px;padding:8px 20px;font:inherit;cursor:pointer}
.result{margin:1em 0;padding:.75em 1em;border-radius:4px}
.result.ok{background:var(--ok-bg);border:1px solid var(--ok-border)}
.result.warn{background:var(--warn-bg);border:1px solid var(--warn-border)}
.result.error{background:var(--error-bg);border:1px solid var(--error-border)}
h2{font-size:1.2em;margin:1.5em 0 .5em}
.filter a[aria-current]{font-weight:bold;text-decoration:none}
.table-wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:.9em}
th,td{padding:4px 6px;border-bottom:1px solid var(--input-border);text-align:left;vertical-align:top}
td.nowrap{white-space:nowrap}
td.reason{overflow-wrap:anywhere}
td.state-error{color:var(--error-border)}
td form{margin:0}
td button{margin:0;padding:2px 10px;white-space:nowrap}
.pager{display:flex;justify-content:space-between;margin:1em 0}
.pager a[rel=next]{margin-left:auto}
`;

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  // 他のサイトのフレームに埋め込まれると、フォームの送信は同じオリジンからになり Origin の確認で止められない
  "X-Frame-Options": "DENY",
};

// 1 回の投入でメッセージが残るのは長くても約 11 時間。hn-processor での再配信が約 3 時間
// （15 分 × 7 回の配信と、倍々の遅延の合計 63 分）、D1 に書けないときの DLQ での再配信が約 8 時間（5 分 × 100 回）。
// それより長く enqueued のままなら、メッセージは失われたとみなして投入し直せるようにする。
// 早すぎると、遅れて届いた DLQ のメッセージが投入し直した行を error にしてしまう
const STALE_ENQUEUED_MS = 12 * 60 * 60 * 1000;

function isStale(enqueuedAtMs: number | null): boolean {
  if (enqueuedAtMs === null) return true;
  return (
    Temporal.Now.instant().epochMilliseconds - enqueuedAtMs > STALE_ENQUEUED_MS
  );
}

// HN の item ID は 1 以上の整数
function parseDigits(text: string): number | null {
  if (!/^[1-9][0-9]*$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

// 管理画面は HN の item を投入するためのものなので、URL は HN 以外のホストを入力ミスとして拒否する
const HN_HOSTNAME = "news.ycombinator.com";

function parseItemId(input: string): number | null {
  const trimmed = input.trim();
  const asNum = parseDigits(trimmed);
  if (asNum !== null) return asNum;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.hostname !== HN_HOSTNAME) return null;
    if (url.pathname !== "/item") return null;
    const idParam = url.searchParams.get("id");
    if (idParam !== null) return parseDigits(idParam);
  } catch {
    // URL として解釈できない入力
  }
  return null;
}

function renderIndexPage(): Response {
  return new Response(
    `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <title>HN Feed Admin</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <h1>HN Feed Admin</h1>
  <ul>
    <li><a href="/enqueue">エンキュー</a> — HN item を手動でキューに追加する</li>
  </ul>
</body>
</html>`,
    { headers: PAGE_HEADERS },
  );
}

async function renderEnqueuePage(
  env: Env,
  query: ListQuery,
  resultHtml: string,
  defaultValue = "",
): Promise<Response> {
  const stateInput =
    query.state !== null
      ? `<input type="hidden" name="state" value="${escapeHtml(query.state)}">`
      : "";
  const taskList = await renderTaskList(env.DB, query);
  return new Response(
    `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <title>エンキュー — HN Feed Admin</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <p><a href="/">← Admin トップ</a></p>
  <h1>エンキュー</h1>
  ${resultHtml}
  <form method="POST" action="/enqueue">
    <p><label for="hn-id">HN item ID または URL</label></p>
    <p>
      <input type="text" id="hn-id" name="id" placeholder="43012345 または https://news.ycombinator.com/item?id=43012345"
        value="${escapeHtml(defaultValue)}" required autocorrect="off" autocapitalize="none" spellcheck="false" enterkeyhint="go" autofocus>
    </p>
    ${stateInput}
    <button type="submit">キューに追加</button>
  </form>
  ${taskList}
</body>
</html>`,
    { headers: PAGE_HEADERS },
  );
}

async function handleEnqueue(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData();
  const input = formData.get("id") ?? "";
  // 一覧の「投入し直す」ボタンから送ったときは、絞り込みを保ったまま結果を出す
  const query: ListQuery = {
    state: parseState(formData.get("state")),
    page: { kind: "first" },
  };
  if (typeof input !== "string") {
    return renderEnqueuePage(
      env,
      query,
      `<div class="result error">ID を入力してください。</div>`,
    );
  }

  if (!input.trim()) {
    return renderEnqueuePage(
      env,
      query,
      `<div class="result error">ID を入力してください。</div>`,
    );
  }

  const itemId = parseItemId(input);
  if (itemId === null) {
    return renderEnqueuePage(
      env,
      query,
      `<div class="result error">&ldquo;${escapeHtml(input)}&rdquo; は有効な HN item ID または URL ではありません。</div>`,
      input,
    );
  }

  const existing = await env.DB.prepare(
    "SELECT state, enqueued_at_ms FROM processed_items WHERE id = ?",
  )
    .bind(itemId)
    .first<{ state: ItemState; enqueued_at_ms: number | null }>();

  const prevState = existing?.state;

  if (prevState === "enqueued" && !isStale(existing?.enqueued_at_ms ?? null)) {
    return renderEnqueuePage(
      env,
      query,
      `<div class="result warn">ID ${itemId} は既にキュー待ち（enqueued）です。</div>`,
    );
  }

  const isReprocess = prevState === "completed";

  const sentAtMs = Temporal.Now.instant().epochMilliseconds;
  await env.QUEUE.send({ itemId });
  await setEnqueued(env.DB, itemId, sentAtMs);

  const action = isReprocess ? "再処理" : "処理";
  const prevNote = prevState ? ` (前の状態: ${prevState})` : "";
  return renderEnqueuePage(
    env,
    query,
    `<div class="result ok">ID ${itemId} の${action}をキューに追加しました${prevNote}。</div>`,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/")
      return renderIndexPage();

    if (request.method === "GET" && url.pathname === "/enqueue")
      return renderEnqueuePage(
        env,
        parseListQuery(url.searchParams),
        "",
        url.searchParams.get("id") ?? "",
      );

    if (request.method === "POST" && url.pathname === "/enqueue") {
      // Access の cookie だけでは送信元を保証できないので、Origin を確かめる。
      // ブラウザは POST に必ず Origin を付けるため、ないものも拒否する
      if (request.headers.get("Origin") !== url.origin)
        return new Response("Forbidden", { status: 403 });
      return handleEnqueue(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};
