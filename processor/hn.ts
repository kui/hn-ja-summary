import type { AlgoliaComment, AlgoliaItem } from "../shared/types.ts";

// Document https://hn.algolia.com/api
const ALGOLIA_API = "https://hn.algolia.com/api/v1";

export async function fetchHNItemWithComments(
  itemId: number,
): Promise<AlgoliaItem | null> {
  const resp = await fetch(`${ALGOLIA_API}/items/${itemId}`);
  if (!resp.ok) return null;
  return resp.json() as Promise<AlgoliaItem>;
}

export function flattenTopComments(
  comments: AlgoliaComment[],
  max: number,
): string[] {
  const result: string[] = [];
  const queue: AlgoliaComment[] = [...comments];

  while (queue.length > 0 && result.length < max) {
    const node = queue.shift()!;
    if (node.text && node.author) {
      const clean = node.text
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      result.push(`[${node.author}]: ${clean}`);
    }
    if (node.children?.length > 0) {
      queue.push(...node.children);
    }
  }

  return result;
}
