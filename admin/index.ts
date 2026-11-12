import { escapeHtml } from "@hn-feed/shared/html";
import { setEnqueued, type ItemState } from "@hn-feed/shared/state";

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
`;

function parseItemId(input: string): number | null {
  const trimmed = input.trim();
  const asNum = parseInt(trimmed, 10);
  if (!isNaN(asNum) && String(asNum) === trimmed) return asNum;

  try {
    const url = new URL(trimmed);
    const idParam = url.searchParams.get("id");
    if (idParam) {
      const parsed = parseInt(idParam, 10);
      if (!isNaN(parsed)) return parsed;
    }
  } catch {
    // input is not a URL
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
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function renderEnqueuePage(resultHtml: string, defaultValue = ""): Response {
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
    <button type="submit">キューに追加</button>
  </form>
</body>
</html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

async function handleEnqueue(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData();
  const input = formData.get("id") ?? "";
  if (typeof input !== "string") {
    return renderEnqueuePage(
      `<div class="result error">ID を入力してください。</div>`,
    );
  }

  if (!input.trim()) {
    return renderEnqueuePage(
      `<div class="result error">ID を入力してください。</div>`,
    );
  }

  const itemId = parseItemId(input);
  if (itemId === null) {
    return renderEnqueuePage(
      `<div class="result error">&ldquo;${escapeHtml(input)}&rdquo; は有効な HN item ID または URL ではありません。</div>`,
      input,
    );
  }

  const existing = await env.DB.prepare(
    "SELECT state FROM processed_items WHERE id = ?",
  )
    .bind(itemId)
    .first<{ state: ItemState }>();

  const prevState = existing?.state;

  if (prevState === "enqueued") {
    return renderEnqueuePage(
      `<div class="result warn">ID ${itemId} は既にキュー待ち（enqueued）です。</div>`,
    );
  }

  const isReprocess = prevState === "completed";

  await setEnqueued(env.DB, itemId);
  await env.QUEUE.send({ itemId });

  const action = isReprocess ? "再処理" : "処理";
  const prevNote = prevState ? ` (前の状態: ${prevState})` : "";
  return renderEnqueuePage(
    `<div class="result ok">ID ${itemId} の${action}をキューに追加しました${prevNote}。</div>`,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/")
      return renderIndexPage();

    if (request.method === "GET" && url.pathname === "/enqueue")
      return renderEnqueuePage("", url.searchParams.get("id") ?? "");

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
