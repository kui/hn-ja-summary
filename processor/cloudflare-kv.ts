import type { FeedItem } from "../shared/types.ts";

const CF_API = "https://api.cloudflare.com/client/v4";
const ITEM_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export class CloudflareKV {
  constructor(
    private readonly accountId: string,
    private readonly namespaceId: string,
    private readonly apiToken: string,
  ) {}

  private get baseUrl(): string {
    return `${CF_API}/accounts/${this.accountId}/storage/kv/namespaces/${this.namespaceId}`;
  }

  async putItem(item: FeedItem): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/bulk`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([{
        key: `item:${item.id}`,
        value: JSON.stringify(item),
        base64: false,
        expiration_ttl: ITEM_TTL_SECONDS,
        metadata: { processedAt: item.processedAt },
      }]),
    });
    if (!resp.ok) {
      throw new Error(
        `KV put failed: ${resp.status} ${await resp.text()}`,
      );
    }
  }
}
