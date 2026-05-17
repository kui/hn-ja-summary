CREATE TABLE IF NOT EXISTS feed_items (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  article_url TEXT NOT NULL,
  hn_url TEXT NOT NULL,
  summary_html TEXT NOT NULL,
  processed_at_ms INTEGER NOT NULL,
  model TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_processed_at_ms ON feed_items (processed_at_ms DESC);