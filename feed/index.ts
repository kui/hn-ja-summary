import type { D1Database } from "@cloudflare/workers-types";
import type { FeedItem } from "@hn-feed/shared/feed";

interface Env {
  DB: D1Database;
  WORKERS_DOMAIN: string;
}

const MAX_FEED_ITEMS = 20;

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/feed.xml") return await handleFeed(env);

    const m = path.match(/^\/items\/(\d+)$/);
    if (m) return await handleItem(env, m[1]);

    return new Response("Not found", { status: 404 });
  },
};

async function handleFeed(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(FEED_SQL)
    .bind(MAX_FEED_ITEMS)
    .all<FeedItem>();

  const feedUrl = `https://${env.WORKERS_DOMAIN}/feed.xml`;
  return new Response(generateRSS(results, feedUrl, env.WORKERS_DOMAIN), {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
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
      const pubDate = new Date(item.createdAt).toUTCString();
      return `
  <item>
    <title><![CDATA[${item.title}]]></title>
    <link>${itemPageUrl}</link>
    <guid isPermaLink="true">${itemPageUrl}</guid>
    <pubDate>${pubDate}</pubDate>
    <description><![CDATA[${item.summaryHtml}<p style="color:#888;font-size:.85em">要約モデル: ${item.model}</p>]]></description>
  </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>HN Summary Feed</title>
    <link>https://news.ycombinator.com</link>
    <description>Summarized Hacker News trending articles (日本語)</description>
    <language>ja</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${esc(feedUrl)}" rel="self" type="application/rss+xml"/>
${itemsXml}
  </channel>
</rss>`;
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
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:800px;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#333}
    h1{font-size:1.4rem;margin-bottom:.5rem}
    .meta{color:#666;font-size:.9rem;margin-bottom:1.5rem}
    .meta a{color:#ff6600}
    h2{font-size:1.1rem;margin-top:1.5rem;color:#555}
    ul{padding-left:1.5rem}
    li{margin-bottom:.5rem}
  </style>
</head>
<body>
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
