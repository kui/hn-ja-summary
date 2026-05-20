export interface FeedItem {
  id: number;
  title: string;
  articleUrl: string;
  hnUrl: string;
  summaryHtml: string;
  createdAt: number; // Unix timestamp (ms)
  model: string;
  hnPostedAt: number | null;
  commentCount: number | null;
  points: number | null;
  commentsUsed: number | null;
  articleChars: number | null;
  articleFetchMethod: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  updatedAt: number | null;
}
