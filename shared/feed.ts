export interface FeedItem {
  id: number;
  title: string;
  articleUrl: string;
  hnUrl: string;
  summaryHtml: string;
  createdAt: number; // Unix timestamp (ms)
  model: string;
}
