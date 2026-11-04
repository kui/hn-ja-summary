import { beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { exports } from "cloudflare:workers";

declare module "vitest" {
  export interface ProvidedContext {
    migrations: D1Migration[];
  }
}

// 属性値・CDATA を閉じて要素を差し込もうとする文字列
const ATTR_ATTACK = `https://example.com/?q="><script>alert(1)</script>`;
const CDATA_ATTACK = `Show HN: a]]><injected/>b`;

interface Row {
  id: number;
  title: string;
  articleUrl: string;
  hnUrl: string;
  summaryHtml: string;
}

async function insertItem(row: Row): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO feed_items (id, created_at_ms, title, article_url, hn_url, summary_html, model)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id,
      1_700_000_000_000,
      row.title,
      row.articleUrl,
      row.hnUrl,
      row.summaryHtml,
      "gemini-test",
    )
    .run();
}

async function get(path: string): Promise<string> {
  const res = await exports.default.fetch(
    `https://${env.WORKERS_DOMAIN}${path}`,
  );
  expect(res.status).toBe(200);
  return await res.text();
}

// HTMLRewriter の getAttribute は文字参照を展開しないので、escapeHtml が出すものだけ戻す
function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

// HTMLRewriter でパースし、リンク先と、差し込まれうる要素・属性の数を集める
async function parseLinks(
  html: string,
): Promise<{ hrefs: string[]; injected: number }> {
  const hrefs: string[] = [];
  let injected = 0;
  await new HTMLRewriter()
    .on("a[href]", {
      element(el) {
        hrefs.push(decodeEntities(el.getAttribute("href") ?? ""));
      },
    })
    .on("script, [onmouseover]", {
      element() {
        injected++;
      },
    })
    .transform(new Response(html))
    .text();
  return { hrefs, injected };
}

// 要素の中身が CDATA セクションだけでできていることを確かめ、連結したテキストを返す
function cdataText(xml: string, tag: string): string[] {
  return [
    ...xml.matchAll(new RegExp(String.raw`<${tag}>([\s\S]*?)</${tag}>`, "g")),
  ].map(([, inner]) => {
    const sections = [...inner.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)];
    expect(sections.map(([s]) => s).join("")).toBe(inner);
    return sections.map(([, text]) => text).join("");
  });
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, inject("migrations"));
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM feed_items").run();
});

describe("記事ページ", () => {
  it("記事 URL と HN URL を属性値としてエスケープする", async () => {
    const hnUrl = `https://news.ycombinator.com/item?id=1" onmouseover="alert(1)`;
    await insertItem({
      id: 1,
      title: "t",
      articleUrl: ATTR_ATTACK,
      hnUrl,
      summaryHtml: "<p>s</p>",
    });

    const { hrefs, injected } = await parseLinks(await get("/items/1"));

    expect(injected).toBe(0);
    expect(hrefs.filter((h) => h === ATTR_ATTACK)).toHaveLength(2);
    expect(hrefs.filter((h) => h === hnUrl)).toHaveLength(2);
  });
});

describe("RSS", () => {
  it("タイトルと description に ]]> が含まれても CDATA が壊れない", async () => {
    const summaryHtml = `<p>x]]><injected/>y</p>`;
    await insertItem({
      id: 1,
      title: CDATA_ATTACK,
      articleUrl: "https://example.com/",
      hnUrl: "https://news.ycombinator.com/item?id=1",
      summaryHtml,
    });

    const xml = await get("/feed.xml");

    // channel の title は CDATA ではないので item の title だけを見る
    const item = xml.slice(xml.indexOf("<item>"));
    expect(cdataText(item, "title")).toEqual([CDATA_ATTACK]);
    const [description] = cdataText(item, "description");
    expect(description.startsWith(summaryHtml)).toBe(true);
  });
});
