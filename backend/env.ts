export interface Env {
  DB: D1Database;
  QUEUE: Queue<{ itemId: number }>;
  GEMINI_API_KEY: string;
  JINA_API_KEY: string;
}
