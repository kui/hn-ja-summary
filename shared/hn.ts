import { MIN_AGE_HOURS, MIN_COMMENTS, VELOCITY_THRESHOLD } from "./filter";

//
const ALGOLIA_API = "https://hn.algolia.com/api/v1";

export interface HNItem {
  id: number;
  type: string;
  by: string;
  time: number;
  score: number;
  descendants?: number;
  title?: string;
  url?: string;
  text?: string;
  kids?: number[];
}

export interface AlgoliaItem {
  id: number;
  title: string | null;
  url: string | null;
  text: string | null;
  author: string;
  points: number;
  created_at: string;
  children: AlgoliaComment[] | null;
}

export interface AlgoliaComment {
  id: number;
  author: string | null;
  text: string | null;
  points: number | null;
  created_at: string;
  children: AlgoliaComment[];
}
const SEARCH_WINDOW_SECONDS = 24 * 60 * 60;
const CANDIDATE_PAGES = [0, 1, 2, 3, 4];

interface AlgoliaSearchHit {
  objectID: string;
  title: string | null;
  url: string | null;
  author: string;
  points: number | null;
  num_comments: number | null;
  created_at_i: number;
  story_text: string | null;
}

interface AlgoliaSearchResponse {
  hits: AlgoliaSearchHit[];
}

function algoliaHitToHNItem(hit: AlgoliaSearchHit): HNItem {
  return {
    id: parseInt(hit.objectID, 10),
    type: "story",
    by: hit.author,
    time: hit.created_at_i,
    score: hit.points ?? 0,
    descendants: hit.num_comments ?? 0,
    title: hit.title ?? undefined,
    url: hit.url ?? undefined,
    text: hit.story_text ?? undefined,
  };
}

export async function fetchCandidateStories(): Promise<HNItem[]> {
  const now = Math.floor(Temporal.Now.instant().epochMilliseconds / 1000);
  const since = now - SEARCH_WINDOW_SECONDS;
  const until = now - MIN_AGE_HOURS;

  const numericFilters = encodeURIComponent(
    [
      `created_at_i>=${since}`,
      `created_at_i<=${until}`,
      `num_comments>=${MIN_COMMENTS}`,
      `points>=${VELOCITY_THRESHOLD}`,
    ].join(","),
  );
  const responses = await Promise.all(
    CANDIDATE_PAGES.map((page) =>
      fetch(
        `${ALGOLIA_API}/search?tags=story&numericFilters=${numericFilters}&page=${page}`,
      ).then((r) =>
        r.ok ? (r.json() as Promise<AlgoliaSearchResponse>) : null,
      ),
    ),
  );

  const seen = new Set<number>();
  const items: HNItem[] = [];
  for (const res of responses) {
    if (!res) continue;
    for (const hit of res.hits) {
      const id = parseInt(hit.objectID, 10);
      if (seen.has(id)) continue;
      seen.add(id);
      items.push(algoliaHitToHNItem(hit));
    }
  }
  return items;
}

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
