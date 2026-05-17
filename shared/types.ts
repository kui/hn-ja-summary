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
  title: string;
  url: string | null;
  text: string | null;
  author: string;
  points: number;
  created_at: string;
  children: AlgoliaComment[];
}

export interface AlgoliaComment {
  id: number;
  author: string | null;
  text: string | null;
  points: number | null;
  created_at: string;
  children: AlgoliaComment[];
}

export interface FeedItem {
  id: number;
  title: string;
  articleUrl: string;
  hnUrl: string;
  summaryHtml: string;
  processedAt: string;
  model: string;
}

export interface ProcessRequest {
  itemId: number;
}

// enqueued: poller が Cloud Tasks にキュー追加済み（リトライ中を含む）
// completed: processor が KV への書き込みまで成功
// error: processor が処理失敗（次回 poller 実行時に再エンキュー）
// skipped: processor が意図的にスキップ（HN アイテム消滅など）
export type ItemState = "enqueued" | "completed" | "error" | "skipped";

export interface ItemRecord {
  state: ItemState;
  enqueuedAt: string;
  updatedAt: string;
  completedAt?: string;
  errorMessage?: string;
  skipReason?: string;
}
