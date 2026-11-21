import { beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import feed from "./index.ts";

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

async function insertItem(
  row: Row,
  createdAt = 1_700_000_000_000,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO feed_items (id, created_at_ms, title, article_url, hn_url, summary_html, model)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id,
      createdAt,
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

const SECTIONED = (jaTitle: string, article: string, hn: string): string =>
  `<section id="article"><h2>${jaTitle}</h2>${article}</section><section id="hn">${hn}</section>`;

async function insertAt(id: number, createdAt: number): Promise<void> {
  await insertItem(
    {
      id,
      title: `title-${id}`,
      articleUrl: "https://example.com/",
      hnUrl: "https://news.ycombinator.com/item?id=1",
      summaryHtml: "<p>s</p>",
    },
    createdAt,
  );
}

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

  it("記録のない値は - で表示する", async () => {
    await insertItem({
      id: 1,
      title: "t",
      articleUrl: "https://example.com/",
      hnUrl: "https://news.ycombinator.com/item?id=1",
      summaryHtml: "<p>s</p>",
    });

    const html = await get("/items/1");

    for (const label of [
      "HN投稿日時",
      "ポイント",
      "コメント数",
      "要約コメント数",
      "記事取得方法",
      "元記事文字数",
      "入力トークン数",
      "出力トークン数",
      "更新日時",
    ]) {
      expect(html).toContain(`<dt>${label}</dt><dd>-</dd>`);
    }
  });

  it("値が 0 でも - にせず表示する", async () => {
    await insertItem({
      id: 1,
      title: "t",
      articleUrl: "https://example.com/",
      hnUrl: "https://news.ycombinator.com/item?id=1",
      summaryHtml: "<p>s</p>",
    });
    await env.DB.prepare(
      "UPDATE feed_items SET points = 0, comment_count = 0 WHERE id = 1",
    ).run();

    const html = await get("/items/1");

    expect(html).toContain("<dt>ポイント</dt><dd>0</dd>");
    expect(html).toContain("<dt>コメント数</dt><dd>0</dd>");
  });

  it("日本語タイトルがあれば、元のタイトルの後ろに括弧で添える", async () => {
    await insertItem({
      id: 1,
      title: "Original",
      articleUrl: "https://example.com/",
      hnUrl: "https://news.ycombinator.com/item?id=1",
      summaryHtml: SECTIONED("日本語題", "<p>概要</p>", ""),
    });

    const html = await get("/items/1");

    expect(html).toContain("<title>Original（日本語題）</title>");
    expect(html).toContain('<meta name="description" content="概要">');
  });

  it("日本語タイトルも本文もなければ、元のタイトルと既定の説明にする", async () => {
    await insertItem({
      id: 1,
      title: "Original",
      articleUrl: "https://example.com/",
      hnUrl: "https://news.ycombinator.com/item?id=1",
      summaryHtml: "<ul><li>x</li></ul>",
    });

    const html = await get("/items/1");

    expect(html).toContain("<title>Original</title>");
    expect(html).toContain(
      '<meta name="description" content="Hacker News のトレンド記事を日本語で要約">',
    );
  });

  it("存在しない項目は 404 にする", async () => {
    const res = await exports.default.fetch(
      `https://${env.WORKERS_DOMAIN}/items/999`,
    );

    expect(res.status).toBe(404);
  });

  it("ADMIN_URL がなければ 500 にする", async () => {
    await insertItem({
      id: 1,
      title: "t",
      articleUrl: "https://example.com/",
      hnUrl: "https://news.ycombinator.com/item?id=1",
      summaryHtml: "<p>s</p>",
    });

    const res = await feed.fetch(
      new Request(`https://${env.WORKERS_DOMAIN}/items/1`),
      { ...env, ADMIN_URL: "" } as unknown as Env,
    );

    expect(res.status).toBe(500);
  });
});

describe("一覧ページ", () => {
  it.each([
    ["カーソルなし", "/"],
    ["カーソルあり", "/?cursor=1700000000000"],
  ])("%s でも記事を返す", async (_, path) => {
    await insertItem({
      id: 1,
      title: "listed-title",
      articleUrl: "https://example.com/",
      hnUrl: "https://news.ycombinator.com/item?id=1",
      summaryHtml: "<p>s</p>",
    });

    expect(await get(path)).toContain("listed-title");
  });

  async function listed(summaryHtml: string): Promise<string> {
    await insertItem({
      id: 1,
      title: "Original",
      articleUrl: "https://example.com/",
      hnUrl: "https://news.ycombinator.com/item?id=1",
      summaryHtml,
    });
    return await get("/");
  }

  it("日本語タイトルと記事の最初の段落を出す", async () => {
    const html = await listed(
      SECTIONED("日本語題", "<p>記事の概要</p>", "<p>議論の概要</p>"),
    );

    expect(html).toContain('<a href="/items/1">日本語題</a>');
    expect(html).toContain("<p>記事の概要</p>");
    expect(html).not.toContain("議論の概要");
  });

  it("記事の段落が定型の注記だけなら、HN の議論の段落を出す", async () => {
    const html = await listed(
      SECTIONED(
        "日本語題",
        '<p class="notice">本文を取得できませんでした。</p>',
        "<p>議論の概要</p>",
      ),
    );

    expect(html).toContain("<p>議論の概要</p>");
    expect(html).not.toContain("本文を取得できませんでした");
  });

  it("section のない古い要約は全体から日本語タイトルと段落を拾う", async () => {
    const html = await listed("<h2>古い題</h2><p>古い概要</p>");

    expect(html).toContain('<a href="/items/1">古い題</a>');
    expect(html).toContain("<p>古い概要</p>");
  });

  it("日本語タイトルも段落もなければ、元のタイトルだけを出す", async () => {
    const html = await listed("<ul><li>x</li></ul>");

    expect(html).toContain('<a href="/items/1">Original</a>');
    expect(html).toMatch(/Original<\/a><\/h2>\s*<\/article>/);
  });

  it("日本語タイトルは記事の section だけから拾い、HN の section の見出しは使わない", async () => {
    const html = await listed(
      `<section id="article"><p>記事の概要</p></section><section id="hn"><h2>議論の見出し</h2></section>`,
    );

    expect(html).toContain('<a href="/items/1">Original</a>');
    expect(html).not.toContain("議論の見出し");
  });

  it("ちょうど 20 件なら次のページへのリンクを出さない", async () => {
    for (let i = 1; i <= 20; i++) await insertAt(i, i * 1000);

    const html = await get("/");

    expect(html.match(/<article>/g)).toHaveLength(20);
    expect(html).not.toContain("<nav");
  });

  it("記事が 1 件もなくても空の一覧を返す", async () => {
    const html = await get("/");

    expect(html).toContain("<h1>HN Summary Feed</h1>");
    expect(html).not.toContain("<article>");
    expect(html).not.toContain("<nav");
  });

  it("20 件を超えると次のページへのリンクを出す", async () => {
    for (let i = 1; i <= 21; i++) await insertAt(i, i * 1000);

    const html = await get("/");

    // 新しい順に 20 件で、21 件目（最古）の作成日時がカーソルになる
    expect(html.match(/<article>/g)).toHaveLength(20);
    expect(html).not.toContain("title-1<");
    expect(html).toContain('<a href="/?cursor=1000">古い記事 →</a>');
    expect(html).toContain('<span class="disabled">← 新しい記事</span>');
  });

  it("カーソルの先に新しい記事があれば、前のページへのリンクを出す", async () => {
    for (let i = 1; i <= 3; i++) await insertAt(i, i * 1000);

    const html = await get("/?cursor=1000");

    expect(html.match(/<article>/g)).toHaveLength(1);
    expect(html).toContain('<a href="/?cursor=3000">← 新しい記事</a>');
    expect(html).toContain('<span class="disabled">古い記事 →</span>');
  });

  it("数値でないカーソルは無視して先頭から出す", async () => {
    await insertAt(1, 1000);

    expect(await get("/?cursor=abc")).toContain("title-1");
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

  it("新しい順に 20 件までの記事を、要約モデルとともに出す", async () => {
    for (let i = 1; i <= 21; i++) await insertAt(i, i * 1000);

    const xml = await get("/feed.xml");

    const links = [...xml.matchAll(/<guid isPermaLink="true">([^<]+)</g)].map(
      ([, link]) => link,
    );
    expect(links).toHaveLength(20);
    expect(links[0]).toBe(`https://${env.WORKERS_DOMAIN}/items/21`);
    expect(links.at(-1)).toBe(`https://${env.WORKERS_DOMAIN}/items/2`);
    expect(xml).toContain("要約モデル: gemini-test");
    expect(xml).toContain("<pubDate>Thu, 01 Jan 1970 00:00:21 GMT</pubDate>");
  });

  it("記事がなくても channel だけの RSS を返す", async () => {
    const xml = await get("/feed.xml");

    expect(xml).toContain("<channel>");
    expect(xml).not.toContain("<item>");
  });
});
