import { beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { exports } from "cloudflare:workers";

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
    .on('input[name="id"]', {
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
