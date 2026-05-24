import { Temporal } from "temporal-polyfill";

const PAGE_STYLE = `
body{max-width:720px;margin:0 auto;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;line-height:1.6;color:#222;background:#fafafa}
h1{font-size:1.5em;margin:.67em 0}
input[type=text]{width:100%;max-width:480px;padding:8px;font-size:1em;border:1px solid #ccc;border-radius:4px;box-sizing:border-box}
button{margin-top:8px;padding:8px 20px;font-size:1em;cursor:pointer}
.result{margin:1em 0;padding:.75em 1em;border-radius:4px}
.result.ok{background:#e8f5e9;border:1px solid #a5d6a7}
.result.warn{background:#fff8e1;border:1px solid #ffe082}
.result.error{background:#ffebee;border:1px solid #ef9a9a}
`;

type ItemState = "enqueued" | "completed" | "error" | "skipped";

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
  <title>エンキュー — HN Feed Admin</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <p><a href="/">← Admin トップ</a></p>
  <h1>エンキュー</h1>
  ${resultHtml}
  <form method="POST" action="/enqueue">
    <p>HN item ID または URL を入力してください。</p>
    <p>
      <input type="text" name="id" placeholder="43012345 または https://news.ycombinator.com/item?id=43012345"
        value="${defaultValue}" autofocus>
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
      `<div class="result error">&ldquo;${input}&rdquo; は有効な HN item ID または URL ではありません。</div>`,
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

  const now = Temporal.Now.instant().epochMilliseconds;
  await env.DB.prepare(
    `INSERT INTO processed_items (id, state, created_at_ms, enqueued_at_ms, updated_at_ms)
     VALUES (?, 'enqueued', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       state = 'enqueued',
       enqueued_at_ms = excluded.enqueued_at_ms,
       updated_at_ms = excluded.updated_at_ms`,
  )
    .bind(itemId, now, now, now)
    .run();
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
      return renderEnqueuePage("");

    if (request.method === "POST" && url.pathname === "/enqueue")
      return handleEnqueue(request, env);

    return new Response("Not found", { status: 404 });
  },
};
