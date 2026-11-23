import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from "vitest";
import { Temporal } from "temporal-polyfill";
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import admin from "./index.ts";
import { PAGE_SIZE } from "./task-list.ts";

declare module "vitest" {
  export interface ProvidedContext {
    migrations: D1Migration[];
  }
}

const ORIGIN = "https://admin.example.com";
// 属性値を閉じて属性や要素を差し込もうとする文字列
const ATTACK = `&"><script>alert(1)</script><input onfocus="alert(1)`;

function postEnqueue(
  id: string,
  headers: Record<string, string> = { Origin: ORIGIN },
): Promise<Response> {
  const body = new FormData();
  body.set("id", id);
  return exports.default.fetch(`${ORIGIN}/enqueue`, {
    method: "POST",
    body,
    headers,
  });
}

// HTMLRewriter の getAttribute は文字参照を展開しないので、escapeHtml が出すものだけ戻す
function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

// HTMLRewriter でパースし、入力欄の値と差し込まれた要素・属性の数を集める
async function parseForm(
  res: Response,
): Promise<{ value: string | null; injected: number }> {
  let value: string | null = null;
  let injected = 0;
  await new HTMLRewriter()
    // 一覧の「投入し直す」ボタンのフォームにも name="id" があるので、入力欄は id で選ぶ
    .on("#hn-id", {
      element(el) {
        value = decodeEntities(el.getAttribute("value") ?? "");
      },
    })
    .on("script, [onfocus]", {
      element() {
        injected++;
      },
    })
    .transform(res)
    .text();
  return { value, injected };
}

async function storedState(id: number): Promise<string | null> {
  return await env.DB.prepare("SELECT state FROM processed_items WHERE id = ?")
    .bind(id)
    .first<string>("state");
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, inject("migrations"));
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM processed_items").run();
  await env.DB.prepare("DELETE FROM feed_items").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function insertEnqueued(id: number, hoursAgo: number): Promise<void> {
  const enqueuedAt =
    Temporal.Now.instant().epochMilliseconds - hoursAgo * 60 * 60 * 1000;
  await env.DB.prepare(
    `INSERT INTO processed_items (id, state, created_at_ms, updated_at_ms, enqueued_at_ms)
     VALUES (?, 'enqueued', 1, 1, ?)`,
  )
    .bind(id, enqueuedAt)
    .run();
}

describe("フレームへの埋め込み", () => {
  it.each([
    ["GET /", () => exports.default.fetch(`${ORIGIN}/`)],
    ["GET /enqueue", () => exports.default.fetch(`${ORIGIN}/enqueue`)],
    ["POST /enqueue", () => postEnqueue("123")],
  ])("%s のレスポンスは埋め込みを禁止する", async (_, request) => {
    const res = await request();

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });
});

describe("GET /enqueue", () => {
  it("id クエリを入力欄の値としてエスケープする", async () => {
    const res = await exports.default.fetch(
      `${ORIGIN}/enqueue?id=${encodeURIComponent(ATTACK)}`,
    );

    expect(await parseForm(res)).toEqual({ value: ATTACK, injected: 0 });
  });
});

describe("POST /enqueue", () => {
  it("不正な入力をエラー文と入力欄でエスケープする", async () => {
    const res = await postEnqueue(ATTACK);

    expect(res.status).toBe(200);
    expect(await parseForm(res.clone())).toEqual({
      value: ATTACK,
      injected: 0,
    });
    expect(await res.text()).toContain(
      "&ldquo;&amp;&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("処理済みの項目は再処理としてキューに戻す", async () => {
    await env.DB.prepare(
      `INSERT INTO processed_items (id, state, created_at_ms, updated_at_ms)
       VALUES (123, 'completed', 1, 1)`,
    ).run();

    const res = await postEnqueue("123");

    expect(await res.text()).toContain("再処理をキューに追加しました");
    expect(await storedState(123)).toBe("enqueued");
  });

  it("投入から 12 時間以内のキュー待ちは受け付けない", async () => {
    await insertEnqueued(123, 1);

    const res = await postEnqueue("123");

    expect(await res.text()).toContain("既にキュー待ち");
  });

  // メッセージが失われ、poller も拾わない状態で残った項目を戻す手段
  it("投入から 12 時間を過ぎたキュー待ちは投入し直す", async () => {
    await insertEnqueued(123, 13);
    const send = vi.spyOn(env.QUEUE, "send");

    const res = await postEnqueue("123");

    expect(await res.text()).toContain("キューに追加しました");
    expect(send).toHaveBeenCalledWith({ itemId: 123 });
  });

  // 状態を変える前に止まるので、もう一度送れば投入できる
  it("送信に失敗したら状態を変えずに失敗する", async () => {
    vi.spyOn(env.QUEUE, "send").mockRejectedValue(new Error("queue is down"));
    // exports.default 経由だと、ハンドラーが投げた例外を workerd が未処理の例外として
    // 標準エラーに出す（テストは成功する）ので、ハンドラーを直接呼ぶ
    const body = new FormData();
    body.set("id", "123");
    const request = new Request(`${ORIGIN}/enqueue`, {
      method: "POST",
      body,
      headers: { Origin: ORIGIN },
    });

    await expect(admin.fetch(request, env)).rejects.toThrow("queue is down");
    expect(await storedState(123)).toBeNull();
  });

  // 前回の投入のエラーが残ると、DLQ で諦めたときの原因を取り違える
  it("投入し直すと前回のエラーを消す", async () => {
    await env.DB.prepare(
      `INSERT INTO processed_items (id, state, created_at_ms, updated_at_ms, error_message)
       VALUES (123, 'error', 1, 1, 'Gemini API error: 503')`,
    ).run();

    await postEnqueue("123");

    const row = await env.DB.prepare(
      "SELECT state, error_message FROM processed_items WHERE id = ?",
    )
      .bind(123)
      .first();
    expect(row).toEqual({ state: "enqueued", error_message: null });
  });

  describe("ID の解釈", () => {
    it.each([
      ["数値", "123", 123],
      ["前後に空白や改行がある数値", "  123 \n", 123],
      ["HN の item URL", "https://news.ycombinator.com/item?id=456", 456],
      [
        "id 以外のクエリもある URL",
        "https://news.ycombinator.com/item?p=2&id=456&x=1",
        456,
      ],
      [
        "前後に空白がある URL",
        "  https://news.ycombinator.com/item?id=456 ",
        456,
      ],
    ])("%s は ID として受け付ける", async (_, input, itemId) => {
      const send = vi.spyOn(env.QUEUE, "send");

      const res = await postEnqueue(input);

      expect(await res.text()).toContain(`ID ${itemId} の処理をキューに追加`);
      expect(send).toHaveBeenCalledWith({ itemId });
      expect(await storedState(itemId)).toBe("enqueued");
    });

    it.each([
      ["数字以外", "abc"],
      ["数字の後に文字が続く", "12abc"],
      ["先頭が 0 の数値", "0123"],
      ["小数", "12.5"],
      ["負の数", "-5"],
      ["0", "0"],
      ["安全に扱える範囲を超える数", "9007199254740993"],
      ["id クエリが負の数の URL", "https://news.ycombinator.com/item?id=-5"],
      ["id クエリが 0 の URL", "https://news.ycombinator.com/item?id=0"],
      [
        "id クエリの数字の後に文字が続く URL",
        "https://news.ycombinator.com/item?id=12abc",
      ],
      ["HN 以外のホストの URL", "https://example.org/item?id=5"],
      ["item 以外のパスの URL", "https://news.ycombinator.com/user?id=12345"],
      [
        "http と https 以外のスキームの URL",
        "ftp://news.ycombinator.com/item?id=5",
      ],
      [
        "HN に似たホスト名の URL",
        "https://news.ycombinator.com.example.org/item?id=5",
      ],
      ["id クエリのない URL", "https://news.ycombinator.com/news"],
      ["id クエリが数値でない URL", "https://news.ycombinator.com/item?id=abc"],
      ["id クエリが空の URL", "https://news.ycombinator.com/item?id="],
    ])("%s は拒否して、キューにも D1 にも触れない", async (_, input) => {
      const send = vi.spyOn(env.QUEUE, "send");

      const res = await postEnqueue(input);

      expect(await res.text()).toContain(
        "は有効な HN item ID または URL ではありません",
      );
      expect(send).not.toHaveBeenCalled();
      expect(
        await env.DB.prepare("SELECT COUNT(*) AS n FROM processed_items").first(
          "n",
        ),
      ).toBe(0);
    });

    it.each([
      ["空文字", ""],
      ["空白だけ", "   "],
    ])(
      "%s は ID の入力を求め、キューにも D1 にも触れない",
      async (_, input) => {
        const send = vi.spyOn(env.QUEUE, "send");

        const res = await postEnqueue(input);

        expect(await res.text()).toContain("ID を入力してください");
        expect(send).not.toHaveBeenCalled();
        expect(
          await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM processed_items",
          ).first("n"),
        ).toBe(0);
      },
    );
  });

  it("同じオリジンからの POST はキューに追加する", async () => {
    const res = await postEnqueue("123");

    expect(res.status).toBe(200);
    expect(await storedState(123)).toBe("enqueued");
  });

  it.each([
    ["他のオリジン", { Origin: "https://evil.example.com" }],
    ["スキームだけ違うオリジン", { Origin: "http://admin.example.com" }],
    ["null オリジン", { Origin: "null" }],
    ["Origin なし", {}],
  ])("%s からの POST は拒否して状態を変えない", async (_, headers) => {
    const res = await postEnqueue("123", headers);

    expect(res.status).toBe(403);
    expect(await storedState(123)).toBeNull();
  });
});

async function insertRow(
  id: number,
  state: string,
  updatedAtMs: number,
  errorMessage: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO processed_items (id, state, created_at_ms, updated_at_ms, error_message)
     VALUES (?, ?, 1, ?, ?)`,
  )
    .bind(id, state, updatedAtMs, errorMessage)
    .run();
}

interface ListedPage {
  ids: number[];
  retryIds: number[];
  older: string | null;
  newer: string | null;
  injected: number;
}

// 一覧の表の ID 列、「投入し直す」ボタンのある行、「前へ」「次へ」のリンクを集める
async function parseList(res: Response): Promise<ListedPage> {
  const page: ListedPage = {
    ids: [],
    retryIds: [],
    older: null,
    newer: null,
    injected: 0,
  };
  let idText = "";
  await new HTMLRewriter()
    .on("tbody tr td:first-child a", {
      text(t) {
        idText += t.text;
        if (t.lastInTextNode) {
          page.ids.push(Number(idText));
          idText = "";
        }
      },
    })
    .on('tbody form input[name="id"]', {
      element(el) {
        page.retryIds.push(Number(el.getAttribute("value")));
      },
    })
    .on(".pager a", {
      element(el) {
        const href = decodeEntities(el.getAttribute("href") ?? "");
        if (el.getAttribute("rel") === "next") page.older = href;
        if (el.getAttribute("rel") === "prev") page.newer = href;
      },
    })
    .on("script, [onfocus]", {
      element() {
        page.injected++;
      },
    })
    .transform(res)
    .text();
  return page;
}

async function getList(path: string): Promise<ListedPage> {
  return parseList(await exports.default.fetch(`${ORIGIN}${path}`));
}

describe("タスク一覧", () => {
  it("更新の新しい順にページに分け、次へと前へで行き来できる", async () => {
    // 同じ更新時刻の行も ID で順序が決まり、ページの境目で抜けも重複もしない
    const total = PAGE_SIZE * 2 + 5;
    for (let id = 1; id <= total; id++)
      await insertRow(id, "completed", Math.ceil(id / 3));
    const expected = Array.from({ length: total }, (_, i) => total - i);

    const first = await getList("/enqueue");
    expect(first.ids).toEqual(expected.slice(0, PAGE_SIZE));
    expect(first.newer).toBeNull();

    const second = await getList(first.older!);
    expect(second.ids).toEqual(expected.slice(PAGE_SIZE, PAGE_SIZE * 2));

    const third = await getList(second.older!);
    expect(third.ids).toEqual(expected.slice(PAGE_SIZE * 2));
    expect(third.older).toBeNull();

    const back = await getList(third.newer!);
    expect(back.ids).toEqual(second.ids);
    const backToFirst = await getList(back.newer!);
    expect(backToFirst.ids).toEqual(first.ids);
    expect(backToFirst.newer).toBeNull();
  });

  it("状態で絞り込む", async () => {
    for (let id = 1; id <= PAGE_SIZE + 2; id++)
      await insertRow(id, id % 2 === 0 ? "error" : "completed", id);
    const errorIds = Array.from(
      { length: PAGE_SIZE + 2 },
      (_, i) => PAGE_SIZE + 2 - i,
    ).filter((id) => id % 2 === 0);

    const first = await getList("/enqueue?state=error");
    expect(first.ids).toEqual(errorIds);
    expect(first.older).toBeNull();
  });

  it("絞り込んだまま次のページに進む", async () => {
    for (let id = 1; id <= PAGE_SIZE * 3; id++)
      await insertRow(id, id % 2 === 0 ? "error" : "completed", id);

    const first = await getList("/enqueue?state=error");
    const second = await getList(first.older!);

    expect(first.older).toContain("state=error");
    expect([...first.ids, ...second.ids]).toEqual(
      Array.from({ length: PAGE_SIZE * 3 }, (_, i) => PAGE_SIZE * 3 - i).filter(
        (id) => id % 2 === 0,
      ),
    );
  });

  it.each([
    ["存在しない状態", "/enqueue?state=unknown"],
    ["形式の違うカーソル", "/enqueue?older=abc"],
  ])("%s は無視して最初のページを出す", async (_, path) => {
    await insertRow(1, "completed", 1);
    await insertRow(2, "error", 2);

    expect((await getList(path)).ids).toEqual([2, 1]);
  });

  it("error の行にだけ「投入し直す」ボタンを出す", async () => {
    await insertRow(1, "completed", 1);
    await insertRow(2, "error", 2);
    await insertRow(3, "skipped", 3);
    await insertRow(4, "enqueued", 4);

    expect((await getList("/enqueue")).retryIds).toEqual([2]);
  });

  it("completed の行には記事のタイトルを出す", async () => {
    await insertRow(1, "completed", 1);
    await env.DB.prepare(
      `INSERT INTO feed_items (id, created_at_ms, title, article_url, hn_url, summary_html, model)
       VALUES (1, 1, 'Show HN: タイトル', 'https://example.com', 'https://news.ycombinator.com/item?id=1', '', 'm')`,
    ).run();

    const res = await exports.default.fetch(`${ORIGIN}/enqueue`);

    expect(await res.text()).toContain("Show HN: タイトル");
  });

  it("エラーの理由とタイトルをエスケープする", async () => {
    await insertRow(1, "error", 1, ATTACK);
    await env.DB.prepare(
      `INSERT INTO feed_items (id, created_at_ms, title, article_url, hn_url, summary_html, model)
       VALUES (1, 1, ?, 'https://example.com', 'https://news.ycombinator.com/item?id=1', '', 'm')`,
    )
      .bind(ATTACK)
      .run();

    const page = await getList("/enqueue");

    expect(page.ids).toEqual([1]);
    expect(page.injected).toBe(0);
  });

  it("「投入し直す」ボタンで送ると、絞り込みを保った一覧を返す", async () => {
    await insertRow(1, "error", 1);
    await insertRow(2, "completed", 2);
    const body = new FormData();
    body.set("id", "1");
    body.set("state", "error");

    const res = await exports.default.fetch(`${ORIGIN}/enqueue`, {
      method: "POST",
      body,
      headers: { Origin: ORIGIN },
    });

    expect(await storedState(1)).toBe("enqueued");
    // 投入し直した行は enqueued になったので、error の一覧からは消える
    expect((await parseList(res)).ids).toEqual([]);
  });
});
