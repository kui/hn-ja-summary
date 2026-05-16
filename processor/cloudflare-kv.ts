import type { FeedItem } from "../shared/types.ts";
import { generateRSS } from "../shared/rss.ts";

const CF_API = "https://api.cloudflare.com/client/v4";
const MAX_FEED_ITEMS = 50;

export class CloudflareKV {
  constructor(
    private readonly accountId: string,
    private readonly namespaceId: string,
    private readonly apiToken: string,
    private readonly workersDomain: string,
  ) {}

  private get baseUrl(): string {
    return `${CF_API}/accounts/${this.accountId}/storage/kv/namespaces/${this.namespaceId}`;
  }

  async get(key: string): Promise<string | null> {
    const resp = await fetch(
      `${this.baseUrl}/values/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${this.apiToken}` } },
    );
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`KV get failed: ${resp.status}`);
    return resp.text();
  }

  private async bulkPut(
    pairs: Array<{ key: string; value: string }>,
  ): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/bulk`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        pairs.map(({ key, value }) => ({ key, value, base64: false })),
      ),
    });
    if (!resp.ok) {
      throw new Error(
        `KV bulk put failed: ${resp.status} ${await resp.text()}`,
      );
    }
  }

  async addFeedItem(newItem: FeedItem): Promise<void> {
    const current = await this.get("feed-items");
    const items: FeedItem[] = current ? JSON.parse(current) : [];

    // Prepend new item, deduplicate, trim to max
    const updated = [newItem, ...items.filter((i) => i.id !== newItem.id)]
      .slice(
        0,
        MAX_FEED_ITEMS,
      );

    const feedUrl = `https://${this.workersDomain}/feed.xml`;

    await this.bulkPut([
      { key: `item:${newItem.id}`, value: renderItemPage(newItem) },
      { key: "feed-items", value: JSON.stringify(updated) },
      { key: "feed", value: generateRSS(updated, feedUrl, this.workersDomain) },
    ]);
  }
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
    処理日時: ${
    new Date(item.processedAt).toLocaleString("ja-JP", {
      timeZone: "Asia/Tokyo",
    })
  }
  </div>
  ${item.summaryHtml}
</body>
</html>`;
}
