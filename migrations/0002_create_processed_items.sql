CREATE TABLE IF NOT EXISTS processed_items (
  id INTEGER PRIMARY KEY,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('enqueued', 'completed', 'error', 'skipped')),
  enqueued_at_ms INTEGER,
  completed_at_ms INTEGER,
  error_message TEXT,
  skip_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_processed_items_state ON processed_items (state);
