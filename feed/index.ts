import { Temporal } from "temporal-polyfill";
import type { FeedItem } from "@hn-feed/shared/feed";
import { escapeHtml, stripHtml } from "@hn-feed/shared/html";

const MAX_FEED_ITEMS = 20;
const GITHUB_REPO = "https://github.com/kui/hn-ja-summary";

const FEED_SQL_DEFAULT = `
SELECT id, title,
  article_url AS articleUrl,
  hn_url AS hnUrl,
  summary_html AS summaryHtml,
  created_at_ms AS createdAt,
  model,
  hn_posted_at_ms AS hnPostedAt,
  comment_count AS commentCount,
  points,
  comments_used AS commentsUsed,
  article_chars AS articleChars,
  article_fetch_method AS articleFetchMethod,
  input_tokens AS inputTokens,
  output_tokens AS outputTokens,
  updated_at_ms AS updatedAt
FROM feed_items
ORDER BY created_at_ms DESC
LIMIT ?
`;

const FEED_SQL_CURSOR = `
SELECT id, title,
  article_url AS articleUrl,
  hn_url AS hnUrl,
  summary_html AS summaryHtml,
  created_at_ms AS createdAt,
  model,
  hn_posted_at_ms AS hnPostedAt,
  comment_count AS commentCount,
  points,
  comments_used AS commentsUsed,
  article_chars AS articleChars,
  article_fetch_method AS articleFetchMethod,
  input_tokens AS inputTokens,
  output_tokens AS outputTokens,
  updated_at_ms AS updatedAt
FROM feed_items
WHERE created_at_ms <= ?
ORDER BY created_at_ms DESC
LIMIT ?
`;

const PREV_CURSOR_SQL = `
SELECT created_at_ms AS createdAt
FROM feed_items
WHERE created_at_ms > ?
ORDER BY created_at_ms ASC
LIMIT ?
`;

const ITEM_SQL = `
SELECT id, title,
  article_url AS articleUrl,
  hn_url AS hnUrl,
  summary_html AS summaryHtml,
  created_at_ms AS createdAt,
  model,
  hn_posted_at_ms AS hnPostedAt,
  comment_count AS commentCount,
  points,
  comments_used AS commentsUsed,
  article_chars AS articleChars,
  article_fetch_method AS articleFetchMethod,
  input_tokens AS inputTokens,
  output_tokens AS outputTokens,
  updated_at_ms AS updatedAt
FROM feed_items
WHERE id = ?
`;

const PAGE_STYLE = `
body{max-width:720px;margin:0 auto;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;line-height:1.6;color:#222;background:#fafafa}
h1{font-size:1.5em;margin:.67em 0}
h2{font-size:1.2em;margin:.5em 0}
h3{font-size:1.05em;margin:.5em 0}
a{color:#1a73e8;text-decoration:none}
a:hover{text-decoration:underline}
article{padding:1em 0;border-bottom:1px solid #e0e0e0}
article:last-child{border:none}
.meta{color:#666;font-size:.85em;margin:0 0 .25em}
.pagination{display:flex;justify-content:space-between;margin:2em 0}
.pagination .disabled{color:#999}
.meta-grid{display:grid;grid-template-columns:auto 1fr;gap:.25em 1em;font-size:.85em;color:#555;margin:1.5em 0}
.meta-grid dt{color:#888}
.meta-grid dd{margin:0}
table{border-collapse:collapse;width:100%;margin:1em 0}
td,th{border:1px solid #ddd;padding:6px 10px;text-align:left}
th{background:#f0f0f0}
ul,ol{padding-left:1.5em}
`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" || path === "") return await handleRoot(env, url);
    if (path === "/feed.xml") return await handleFeed(env);

    const m = path.match(/^\/items\/(\d+)$/);
    if (m) return await handleItem(env, m[1], url);

    return new Response("Not found", { status: 404 });
  },
};

async function handleRoot(env: Env, url: URL): Promise<Response> {
  const FETCH = MAX_FEED_ITEMS + 1;
  const cursorParam = url.searchParams.get("cursor");
  const cursor = cursorParam ? parseInt(cursorParam, 10) : null;
  const validCursor = cursor !== null && !isNaN(cursor);

  const [pageResult, prevResult] = await Promise.all([
    validCursor
      ? env.DB.prepare(FEED_SQL_CURSOR).bind(cursor, FETCH).all<FeedItem>()
      : env.DB.prepare(FEED_SQL_DEFAULT).bind(FETCH).all<FeedItem>(),
    validCursor
      ? env.DB.prepare(PREV_CURSOR_SQL)
          .bind(cursor, MAX_FEED_ITEMS)
          .all<{ createdAt: number }>()
      : Promise.resolve<{ results: { createdAt: number }[] }>({ results: [] }),
  ]);

  const raw = pageResult.results;
  const hasMore = raw.length > MAX_FEED_ITEMS;
  const items = raw.slice(0, MAX_FEED_ITEMS);
  const prevItems = prevResult.results;

  const nextUrl = hasMore ? `/?cursor=${raw[MAX_FEED_ITEMS].createdAt}` : null;
  const prevUrl =
    prevItems.length > 0
      ? `/?cursor=${prevItems[prevItems.length - 1].createdAt}`
      : null;

  return new Response(renderIndexPage(items, prevUrl, nextUrl, url.href), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=600",
    },
  });
}

async function handleFeed(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(FEED_SQL_DEFAULT)
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

async function handleItem(env: Env, id: string, url: URL): Promise<Response> {
  if (!env.ADMIN_URL)
    return new Response("Missing required env var: ADMIN_URL", { status: 500 });

  const item = await env.DB.prepare(ITEM_SQL)
    .bind(parseInt(id, 10))
    .first<FeedItem>();

  if (!item) return new Response("Item not found", { status: 404 });
  return new Response(renderItemPage(item, url.href, env.ADMIN_URL), {
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
    <atom:link href="${escapeHtml(feedUrl)}" rel="self" type="application/rss+xml"/>
${itemsXml}
  </channel>
</rss>`;
}

function toRFC822(epochMs: number): string {
  // RFC 822 形式（RSS pubDate 用）は Temporal に相当するAPIがないため Date を例外使用
  // eslint-disable-next-line no-restricted-globals, no-restricted-syntax
  return new Date(epochMs).toUTCString();
}

function fmtDate(ms: number | null): string {
  if (!ms) return "-";
  return Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO("Asia/Tokyo")
    .toLocaleString("ja-JP");
}

function fmtVal<T>(v: T | null): string {
  return v !== null ? String(v) : "-";
}

function extractFirstH2(html: string): string {
  const m = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  return m ? stripHtml(m[1]) : "";
}

function extractFirstP(html: string): string {
  const m = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  return m ? m[1].trim() : "";
}

function renderIndexPage(
  items: FeedItem[],
  prevUrl: string | null,
  nextUrl: string | null,
  pageUrl: string,
): string {
  const itemsHtml = items
    .map((item) => {
      const jaTitle = escapeHtml(
        extractFirstH2(item.summaryHtml) || item.title,
      );
      const firstP = extractFirstP(item.summaryHtml);
      return `
  <article>
    <p class="meta">${fmtDate(item.createdAt)}</p>
    <h2><a href="/items/${item.id}">${jaTitle}</a></h2>
    ${firstP ? `<p>${firstP}</p>` : ""}
  </article>`;
    })
    .join("\n");

  const paginationHtml =
    prevUrl || nextUrl
      ? `
  <nav class="pagination">
    ${prevUrl ? `<a href="${prevUrl}">← 新しい記事</a>` : `<span class="disabled">← 新しい記事</span>`}
    ${nextUrl ? `<a href="${nextUrl}">古い記事 →</a>` : `<span class="disabled">古い記事 →</span>`}
  </nav>`
      : "";

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HN Summary Feed</title>
  <meta name="description" content="Hacker News のトレンド記事を日本語で要約">
  <meta property="og:title" content="HN Summary Feed">
  <meta property="og:description" content="Hacker News のトレンド記事を日本語で要約">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${escapeHtml(pageUrl)}">
  <meta property="og:site_name" content="HN Summary Feed">
  <meta name="twitter:card" content="summary">
  <link rel="alternate" type="application/rss+xml" title="HN Summary Feed" href="/feed.xml">
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <h1>HN Summary Feed</h1>
  <p>Hacker News のトレンド記事を日本語で要約 ｜ <a href="/feed.xml">RSS</a> ｜ <a href="${GITHUB_REPO}" target="_blank" rel="noopener">GitHub</a></p>
${itemsHtml}
${paginationHtml}
</body>
</html>`;
}

function renderItemPage(
  item: FeedItem,
  pageUrl: string,
  adminUrl: string,
): string {
  const jaTitle = extractFirstH2(item.summaryHtml);
  const displayTitle = jaTitle
    ? `${escapeHtml(item.title)}（${escapeHtml(jaTitle)}）`
    : escapeHtml(item.title);
  const firstP = extractFirstP(item.summaryHtml);
  const ogDesc = firstP
    ? escapeHtml(stripHtml(firstP))
    : "Hacker News のトレンド記事を日本語で要約";

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${displayTitle}</title>
  <meta name="description" content="${ogDesc}">
  <meta property="og:title" content="${displayTitle}">
  <meta property="og:description" content="${ogDesc}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${escapeHtml(pageUrl)}">
  <meta property="og:site_name" content="HN Summary Feed">
  <meta name="twitter:card" content="summary">
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <p><a href="/">← 一覧へ</a></p>
  <h1>${escapeHtml(item.title)}</h1>
  <p class="meta">
    HN投稿日時: ${fmtDate(item.hnPostedAt)} ｜
    処理日時: ${fmtDate(item.createdAt)} ｜
    <a href="${item.articleUrl}" target="_blank" rel="noopener">元記事</a> ｜
    <a href="${item.hnUrl}" target="_blank" rel="noopener">HNディスカッション</a>
  </p>
  <article>
    ${item.summaryHtml}
  </article>
  <dl class="meta-grid">
    <dt>元記事</dt><dd><a href="${item.articleUrl}" target="_blank" rel="noopener">${escapeHtml(item.articleUrl)}</a></dd>
    <dt>HNディスカッション</dt><dd><a href="${item.hnUrl}" target="_blank" rel="noopener">${escapeHtml(item.hnUrl)}</a></dd>
    <dt>HN投稿日時</dt><dd>${fmtDate(item.hnPostedAt)}</dd>
    <dt>ポイント</dt><dd>${fmtVal(item.points)}</dd>
    <dt>コメント数</dt><dd>${fmtVal(item.commentCount)}</dd>
    <dt>要約コメント数</dt><dd>${fmtVal(item.commentsUsed)}</dd>
    <dt>記事取得方法</dt><dd>${fmtVal(item.articleFetchMethod)}</dd>
    <dt>元記事文字数</dt><dd>${fmtVal(item.articleChars)}</dd>
    <dt>入力トークン数</dt><dd>${fmtVal(item.inputTokens)}</dd>
    <dt>出力トークン数</dt><dd>${fmtVal(item.outputTokens)}</dd>
    <dt>モデル</dt><dd>${escapeHtml(item.model)}</dd>
    <dt>処理日時</dt><dd>${fmtDate(item.createdAt)}</dd>
    <dt>更新日時</dt><dd>${fmtDate(item.updatedAt)}</dd>
  </dl>
  <p><a href="${escapeHtml(adminUrl)}/enqueue?id=${item.id}" target="_blank" rel="noopener">再処理</a></p>
</body>
</html>`;
}
