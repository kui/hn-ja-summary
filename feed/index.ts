import { Temporal } from "temporal-polyfill";
import type { FeedItem } from "@hn-feed/shared/feed";

const MAX_FEED_ITEMS = 20;
const GITHUB_REPO = "https://github.com/kui/hn-ja-summary";

const FEED_SQL = `
SELECT id, title,
  article_url AS articleUrl,
  hn_url AS hnUrl,
  summary_html AS summaryHtml,
  created_at_ms AS createdAt,
  model
FROM feed_items
ORDER BY created_at_ms DESC
LIMIT ?
`;

const ITEM_SQL = `
SELECT id, title,
  article_url AS articleUrl,
  hn_url AS hnUrl,
  summary_html AS summaryHtml,
  created_at_ms AS createdAt,
  model
FROM feed_items
WHERE id = ?
`;

const PAGE_STYLE = `
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  max-width:800px;
  margin:2rem auto;
  padding:0 1rem;
  line-height:1.6;
  color:#333
}
h1{font-size:1.4rem;margin-bottom:.5rem}
.meta{color:#666;font-size:.9rem;margin-bottom:1.5rem}
.meta a{color:#ff6600}
h2{font-size:1.1rem;margin-top:1.5rem;color:#555}
ul{padding-left:1.5rem}
li{margin-bottom:.5rem}
`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" || path === "") return await handleRoot(env);
    if (path === "/feed.xml") return await handleFeed(env);

    const m = path.match(/^\/items\/(\d+)$/);
    if (m) return await handleItem(env, m[1]);

    return new Response("Not found", { status: 404 });
  },
};

async function handleRoot(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(FEED_SQL)
    .bind(MAX_FEED_ITEMS)
    .all<FeedItem>();

  return new Response(renderIndexPage(results), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=600",
    },
  });
}

async function handleFeed(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(FEED_SQL)
    .bind(MAX_FEED_ITEMS)
    .all<FeedItem>();

  const feedUrl = `https://${env.WORKERS_DOMAIN}/feed.xml`;
  return new Response(generateRSS(results, feedUrl, env.WORKERS_DOMAIN), {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=600",
    },
  });
}

async function handleItem(env: Env, id: string): Promise<Response> {
  const item = await env.DB.prepare(ITEM_SQL)
    .bind(parseInt(id, 10))
    .first<FeedItem>();

  if (!item) return new Response("Item not found", { status: 404 });
  return new Response(renderItemPage(item), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

function generateRSS(
  items: FeedItem[],
  feedUrl: string,
  workersDomain: string,
): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const itemsXml = items
    .map((item) => {
      const itemPageUrl = `https://${workersDomain}/items/${item.id}`;
      return `
  <item>
    <title><![CDATA[${item.title}]]></title>
    <link>${itemPageUrl}</link>
    <guid isPermaLink="true">${itemPageUrl}</guid>
    <pubDate>${toRFC822(item.createdAt)}</pubDate>
    <description><![CDATA[${item.summaryHtml}<p style="color:#888;font-size:.85em">要約モデル: ${item.model}</p>]]></description>
  </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>HN Summary Feed</title>
    <link>https://${workersDomain}/</link>
    <description>Hacker News のトレンド記事を日本語で要約</description>
    <language>ja</language>
    <lastBuildDate>${toRFC822(Temporal.Now.instant().epochMilliseconds)}</lastBuildDate>
    <atom:link href="${esc(feedUrl)}" rel="self" type="application/rss+xml"/>
${itemsXml}
  </channel>
</rss>`;
}

function toRFC822(epochMs: number): string {
  return new Date(epochMs).toUTCString();
}

function extractFirstH2(html: string): string {
  const m = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
}

function extractFirstP(html: string): string {
  const m = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  return m ? m[1].trim() : "";
}

function renderIndexPage(items: FeedItem[]): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const itemsHtml = items
    .map((item) => {
      const jaTitle = esc(extractFirstH2(item.summaryHtml) || item.title);
      const firstP = extractFirstP(item.summaryHtml);
      const date = Temporal.Instant.fromEpochMilliseconds(item.createdAt)
        .toZonedDateTimeISO("Asia/Tokyo")
        .toLocaleString("ja-JP");
      return `
  <article>
    <div class="meta">${date}</div>
    <h2><a href="/items/${item.id}">${jaTitle}</a></h2>
    ${firstP ? `<p>${firstP}</p>` : ""}
  </article>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HN Summary Feed</title>
  <meta name="description" content="Hacker News のトレンド記事を日本語で要約">
  <link rel="alternate" type="application/rss+xml" title="HN Summary Feed" href="/feed.xml">
  <style>
    ${PAGE_STYLE}
    article{border-bottom:1px solid #eee;padding-bottom:1.5rem;margin-bottom:1.5rem}
    article h2{margin-top:.25rem}
    article h2 a{color:#333;text-decoration:none}
    article h2 a:hover{color:#ff6600;text-decoration:underline}
    article p{margin:.5rem 0 0;color:#444;font-size:.95rem}
    .site-desc{color:#555;font-size:.95rem;margin-bottom:2rem}
    .site-desc a{color:#ff6600}
  </style>
</head>
<body>
  <h1>HN Summary Feed</h1>
  <div class="site-desc">
    Hacker News のトレンド記事を日本語で要約
    <a href="/feed.xml">RSS</a> ｜
    <a href="${GITHUB_REPO}" target="_blank" rel="noopener">GitHub</a>
  </div>
${itemsHtml}
</body>
</html>`;
}

function renderItemPage(item: FeedItem): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(item.title)}</title>
  <style>
    ${PAGE_STYLE}
  </style>
</head>
<body>
  <p class="meta"><a href="/">← 一覧へ</a></p>
  <h1>${esc(item.title)}</h1>
  <div class="meta">
    <a href="${item.articleUrl}" target="_blank" rel="noopener">元記事</a>
    ｜
    <a href="${item.hnUrl}" target="_blank" rel="noopener">HNディスカッション</a>
    ｜
    処理日時: ${new Date(item.createdAt).toLocaleString("ja-JP", {
      timeZone: "Asia/Tokyo",
    })} ｜ モデル: ${esc(item.model)}
  </div>
  ${item.summaryHtml}
</body>
</html>`;
}
