import type { HNItem } from "../shared/types.ts";

const HN_API = "https://hacker-news.firebaseio.com/v0";

export async function fetchTopStoryIds(): Promise<number[]> {
  const resp = await fetch(`${HN_API}/topstories.json`);
  if (!resp.ok) throw new Error(`HN topstories failed: ${resp.status}`);
  return resp.json() as Promise<number[]>;
}

export async function fetchItem(id: number): Promise<HNItem | null> {
  const resp = await fetch(`${HN_API}/item/${id}.json`);
  if (!resp.ok) return null;
  return resp.json() as Promise<HNItem | null>;
}

export async function fetchItemsBatch(
  ids: number[],
  concurrency = 20,
): Promise<HNItem[]> {
  const results: HNItem[] = [];
  for (let i = 0; i < ids.length; i += concurrency) {
    const batch = ids.slice(i, i + concurrency);
    const items = await Promise.all(batch.map(fetchItem));
    for (const item of items) {
      if (item && item.type === "story") results.push(item);
    }
  }
  return results;
}
