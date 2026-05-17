import type { FeedItem } from "./types.ts";

export function generateRSS(
  items: FeedItem[],
  feedUrl: string,
  workersDomain: string,
): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const itemsXml = items
    .map((item) => {
      const itemPageUrl = `https://${workersDomain}/items/${item.id}`;
      const pubDate = new Date(item.processedAt).toUTCString();
      const modelNote = item.model
        ? `<p style="color:#888;font-size:.85em">要約モデル: ${item.model}</p>`
        : "";
      return `
  <item>
    <title><![CDATA[${item.title}]]></title>
    <link>${itemPageUrl}</link>
    <guid isPermaLink="true">${itemPageUrl}</guid>
    <pubDate>${pubDate}</pubDate>
    <description><![CDATA[${item.summaryHtml}${modelNote}]]></description>
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
