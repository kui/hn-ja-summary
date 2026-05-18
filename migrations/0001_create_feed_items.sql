CREATE TABLE IF NOT EXISTS feed_items (
  id INTEGER PRIMARY KEY,
  created_at_ms INTEGER NOT NULL,
  title TEXT NOT NULL,
  article_url TEXT NOT NULL,
  hn_url TEXT NOT NULL,
  summary_html TEXT NOT NULL,
  model TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feed_items_created_at_ms ON feed_items (created_at_ms DESC);
