import { Temporal } from "temporal-polyfill";
import { MIN_AGE_HOURS, MIN_COMMENTS, SEARCH_WINDOW_HOURS } from "./filter.ts";

// Document https://hn.algolia.com/api
const ALGOLIA_API = "https://hn.algolia.com/api/v1";

export interface HNItem {
  id: number;
  type: string;
  by: string;
  time: number;
  points: number;
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

export function countComments(item: AlgoliaItem): number | null {
  if (!item.children) return null;
  let count = 0;
  const stack = [...item.children];
  while (stack.length > 0) {
    const comment = stack.pop()!;
    count++;
    if (comment.children) {
      stack.push(...comment.children);
    }
  }
  return count;
}

export interface AlgoliaComment {
  id: number;
  author: string | null;
  text: string | null;
  points: number | null;
  created_at: string;
  children: AlgoliaComment[];
}
// Algolia が 1 リクエストで返せる上限。これを超える件数は取得できない
const MAX_HITS_PER_PAGE = 1000;

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
  nbHits: number;
}

function algoliaHitToHNItem(hit: AlgoliaSearchHit): HNItem {
  return {
    id: parseInt(hit.objectID, 10),
    type: "story",
    by: hit.author,
    time: hit.created_at_i,
    points: hit.points ?? 0,
    descendants: hit.num_comments ?? 0,
    title: hit.title ?? undefined,
    url: hit.url ?? undefined,
    text: hit.story_text ?? undefined,
  };
}

export async function fetchCandidateStories(): Promise<HNItem[]> {
  const now = Math.floor(Temporal.Now.instant().epochMilliseconds / 1000);
  // 対象期間の全ストーリーは 1 回で取得できる件数を超えるので、Algolia 側で絞る。
  // points や num_comments で絞るクエリは、ドキュメントにあるのに HTTP 400 を返す時期があった。
  // 再発したら created_at_i だけで取得してクライアント側で絞る（実装例: 2e0cd4b）。
  const numericFilters = encodeURIComponent(
    [
      `created_at_i>=${now - SEARCH_WINDOW_HOURS * 3600}`,
      `created_at_i<=${now - MIN_AGE_HOURS * 3600}`,
      `num_comments>=${MIN_COMMENTS}`,
    ].join(","),
  );
  const resp = await fetch(
    `${ALGOLIA_API}/search?tags=story&numericFilters=${numericFilters}&hitsPerPage=${MAX_HITS_PER_PAGE}`,
  );
  if (!resp.ok) {
    console.error(`Algolia search failed: ${resp.status}`);
    return [];
  }
  const res = await resp.json<AlgoliaSearchResponse>();

  // nbPages は hitsPerPage=1000 だと常に 1 になるため、取り切れたかは nbHits で判定する
  if (res.nbHits > res.hits.length) {
    console.warn(
      `WARNING: Algolia matched ${res.nbHits} stories but only ${res.hits.length} were fetched. Some candidates may be missed.`,
    );
  }

  return res.hits.map(algoliaHitToHNItem);
}

export async function fetchHNItemWithComments(
  itemId: number,
): Promise<AlgoliaItem | null> {
  const resp = await fetch(`${ALGOLIA_API}/items/${itemId}`);
  if (!resp.ok) return null;
  return resp.json<AlgoliaItem>();
}

const MIN_TEXT_LENGTH = 20;

function makeSubtreeCounter() {
  const cache = new Map<number, number>();
  function count(comment: AlgoliaComment): number {
    const cached = cache.get(comment.id);
    if (cached !== undefined) return cached;
    const result = 1 + comment.children.reduce((sum, c) => sum + count(c), 0);
    cache.set(comment.id, result);
    return result;
  }
  return count;
}

export function flattenTopComments(
  comments: AlgoliaComment[],
  max: number,
): string[] {
  const countSubtree = makeSubtreeCounter();
  const bySubtreeDesc = (a: AlgoliaComment, b: AlgoliaComment) =>
    countSubtree(b) - countSubtree(a);

  // Pass 1: greedy でどのノードを含めるか選定する
  const selected = new Set<number>();
  const pq: AlgoliaComment[] = [...comments];

  while (pq.length > 0 && selected.size < max) {
    pq.sort(bySubtreeDesc);
    const node = pq.shift()!;

    const hasChildren = node.children.length > 0;
    if (hasChildren) {
      // 枝
      selected.add(node.id);
    } else {
      // 葉（返信のないコメント）は短い・null なら弾く
      if (node.text && node.text.length >= MIN_TEXT_LENGTH) {
        selected.add(node.id);
      }
    }

    for (const child of node.children ?? []) {
      pq.push(child);
    }
  }

  // Pass 2: 元のツリー構造を DFS して選定ノードを正しい深さで出力する
  const result: string[] = [];

  function visit(node: AlgoliaComment, depth: number): void {
    if (selected.has(node.id)) {
      const author = node.author ?? "-";
      result.push(`${"  ".repeat(depth)}[${author}]: ${node.text ?? "-"}`);
    }

    for (const child of [...(node.children ?? [])].sort(bySubtreeDesc)) {
      visit(child, depth + 1);
    }
  }

  for (const comment of [...comments].sort(bySubtreeDesc)) {
    visit(comment, 0);
  }

  return result;
}
