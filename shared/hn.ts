import { Temporal } from "temporal-polyfill";
import { MIN_AGE_HOURS, MIN_COMMENTS, SEARCH_WINDOW_HOURS } from "./filter.ts";
import { decodeHtmlEntities } from "./html.ts";

// Document https://hn.algolia.com/api
const ALGOLIA_API = "https://hn.algolia.com/api/v1";

export interface HNItem {
  id: number;
  type: string;
  by: string;
  time: number;
  points: number;
  title?: string;
  url?: string;
  text?: string;
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
  created_at_i: number;
  story_text: string | null;
}

interface AlgoliaSearchResponse<Hit> {
  hits: Hit[];
  nbHits: number;
}

function algoliaHitToHNItem(hit: AlgoliaSearchHit): HNItem {
  return {
    id: parseInt(hit.objectID, 10),
    type: "story",
    by: hit.author,
    time: hit.created_at_i,
    points: hit.points ?? 0,
    title: hit.title ?? undefined,
    url: hit.url ?? undefined,
    text: hit.story_text ?? undefined,
  };
}

export async function fetchCandidateStories(): Promise<HNItem[]> {
  const now = Math.floor(Temporal.Now.instant().epochMilliseconds / 1000);
  // 対象期間の全ストーリーは 1 回で取得できる件数を超えるので、Algolia 側で絞る。
  // points や num_comments で絞るクエリは、ドキュメントにあっても HTTP 400 を返すことがある。
  // そうなったら created_at_i だけで絞り、1000 件を超えないよう期間を分けて取得して、コメント数はクライアント側で判定する。
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
  const res = await resp.json<AlgoliaSearchResponse<AlgoliaSearchHit>>();

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
  const item = await resp.json<AlgoliaItem>();

  // items/:id は dead なコメントとその下の返信をツリーから除くので、検索 API で補う
  try {
    addMissingComments(item, await fetchCommentHits(itemId));
  } catch (e) {
    console.warn(`Failed to add comments from search for ${itemId}:`, e);
  }
  return item;
}

// 検索はコメントを補うだけなので、応答が止まっても要約の処理を長く待たせない
const COMMENT_SEARCH_TIMEOUT_MS = 10_000;

interface AlgoliaCommentHit {
  objectID: string;
  author: string | null;
  comment_text: string | null;
  created_at: string;
  parent_id: number;
}

async function fetchCommentHits(itemId: number): Promise<AlgoliaCommentHit[]> {
  const resp = await fetch(
    `${ALGOLIA_API}/search_by_date?tags=comment,story_${itemId}&hitsPerPage=${MAX_HITS_PER_PAGE}`,
    { signal: AbortSignal.timeout(COMMENT_SEARCH_TIMEOUT_MS) },
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const res = await resp.json<AlgoliaSearchResponse<AlgoliaCommentHit>>();

  if (res.nbHits > res.hits.length) {
    console.warn(
      `WARNING: Algolia matched ${res.nbHits} comments for ${itemId} but only ${res.hits.length} were fetched. Older comments may be missed.`,
    );
  }
  return res.hits;
}

function algoliaCommentHitToComment(hit: AlgoliaCommentHit): AlgoliaComment {
  return {
    id: parseInt(hit.objectID, 10),
    author: hit.author,
    text: hit.comment_text,
    points: null,
    created_at: hit.created_at,
    children: [],
  };
}

function addMissingComments(
  item: AlgoliaItem,
  hits: AlgoliaCommentHit[],
): void {
  const commentsById = new Map<number, AlgoliaComment>();
  const stack = [...(item.children ?? [])];
  while (stack.length > 0) {
    const comment = stack.pop()!;
    commentsById.set(comment.id, comment);
    stack.push(...comment.children);
  }

  const added = hits
    .map((hit) => ({
      parentId: hit.parent_id,
      comment: algoliaCommentHitToComment(hit),
    }))
    .filter(({ comment }) => !commentsById.has(comment.id));
  if (added.length === 0) return;

  // 検索結果は親より返信が先に並ぶので、全件を登録してから親につなぐ
  for (const { comment } of added) {
    commentsById.set(comment.id, comment);
  }
  const topLevel = item.children ?? [];
  for (const { parentId, comment } of added) {
    // 親が見つからなければトップレベルに置く。親が dead か、検索の上限で欠けた返信もここに来る
    (commentsById.get(parentId)?.children ?? topLevel).push(comment);
  }
  item.children = topLevel;
}

const MIN_TEXT_LENGTH = 20;

function makeSubtreeCounter() {
  const cache = new Map<AlgoliaComment, number>();
  function count(comment: AlgoliaComment): number {
    const cached = cache.get(comment);
    if (cached !== undefined) return cached;
    const result = 1 + comment.children.reduce((sum, c) => sum + count(c), 0);
    cache.set(comment, result);
    return result;
  }
  return count;
}

// HN のリンクテキストは URL かその省略形だけなので、href に置き換えても情報は減らない
function commentToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<a\s[^>]*href="([^"]*)"[^>]*>.*?<\/a>/gs, "$1")
      .replace(/<p>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{2,}/g, "\n")
      .trim(),
  );
}

function selectComments(
  comments: AlgoliaComment[],
  max: number,
  countSubtree: (comment: AlgoliaComment) => number,
): Set<AlgoliaComment> {
  const selected = new Set<AlgoliaComment>();
  // queues[n] には、自身と子孫を合わせて n 件になるコメントを入れ、n の大きい順に処理する。
  // 子の n は親より必ず小さいので、処理中や処理済みの queues には入らない。
  const queues: AlgoliaComment[][] = [];
  const enqueue = (node: AlgoliaComment) => {
    (queues[countSubtree(node)] ??= []).push(node);
  };
  for (const comment of comments) {
    enqueue(comment);
  }

  for (let size = queues.length - 1; size > 0; size--) {
    for (const node of queues[size] ?? []) {
      if (selected.size >= max) return selected;

      const hasChildren = node.children.length > 0;
      if (hasChildren || (node.text && node.text.length >= MIN_TEXT_LENGTH)) {
        selected.add(node);
      }

      for (const child of node.children) {
        enqueue(child);
      }
    }
  }
  return selected;
}

export function flattenTopComments(
  comments: AlgoliaComment[],
  max: number,
): string[] {
  const countSubtree = makeSubtreeCounter();
  const bySubtreeDesc = (a: AlgoliaComment, b: AlgoliaComment) =>
    countSubtree(b) - countSubtree(a);

  const selected = selectComments(comments, max, countSubtree);

  // 元のツリー構造を DFS して選定ノードを正しい深さで出力する
  const result: string[] = [];

  function visit(node: AlgoliaComment, depth: number): void {
    if (selected.has(node)) {
      const author = node.author ?? "-";
      const indent = "  ".repeat(depth);
      const text = commentToText(node.text ?? "-").replace(
        /\n/g,
        `\n${indent}`,
      );
      result.push(`${indent}[${author}]: ${text}`);
    }

    for (const child of [...node.children].sort(bySubtreeDesc)) {
      visit(child, depth + 1);
    }
  }

  for (const comment of [...comments].sort(bySubtreeDesc)) {
    visit(comment, 0);
  }

  return result;
}
