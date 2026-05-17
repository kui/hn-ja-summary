import type { FeedItem } from "../shared/types.ts";

const CF_API = "https://api.cloudflare.com/client/v4";

const UPSERT_ITEM = `
INSERT INTO feed_items
  (id, title, article_url, hn_url, summary_html, processed_at_ms, model)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  title = excluded.title,
  article_url = excluded.article_url,
  hn_url = excluded.hn_url,
  summary_html = excluded.summary_html,
  processed_at_ms = excluded.processed_at_ms,
  model = excluded.model
`;

export class CloudflareD1 {
  private readonly baseUrl: string;

  constructor(
    accountId: string,
    databaseId: string,
    private readonly apiToken: string,
  ) {
    this.baseUrl = `${CF_API}/accounts/${accountId}/d1/database/${databaseId}`;
  }

  async putItem(item: FeedItem): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sql: UPSERT_ITEM,
        params: [
          item.id,
          item.title,
          item.articleUrl,
          item.hnUrl,
          item.summaryHtml,
          item.processedAt,
          item.model,
        ],
      }),
    });
    if (!resp.ok) {
      throw new Error(`D1 query failed: ${resp.status} ${await resp.text()}`);
    }
    const data = await resp.json() as { success: boolean; errors: unknown[] };
    if (!data.success) {
      throw new Error(`D1 query error: ${JSON.stringify(data.errors)}`);
    }
  }
}
