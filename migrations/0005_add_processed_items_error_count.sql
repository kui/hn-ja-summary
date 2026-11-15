-- SQLite は CHECK 制約を変更できないので、表を作り直して state に 'failed' を加える
CREATE TABLE processed_items_new (
  id INTEGER PRIMARY KEY,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('enqueued', 'completed', 'error', 'failed', 'skipped')
  ),
  enqueued_at_ms INTEGER,
  completed_at_ms INTEGER,
  error_message TEXT,
  skip_reason TEXT,
  error_count INTEGER NOT NULL DEFAULT 0
);

INSERT INTO
  processed_items_new (
    id,
    created_at_ms,
    updated_at_ms,
    state,
    enqueued_at_ms,
    completed_at_ms,
    error_message,
    skip_reason
  )
SELECT
  id,
  created_at_ms,
  updated_at_ms,
  state,
  enqueued_at_ms,
  completed_at_ms,
  error_message,
  skip_reason
FROM
  processed_items;

DROP TABLE processed_items;

ALTER TABLE processed_items_new
RENAME TO processed_items;

CREATE INDEX IF NOT EXISTS idx_processed_items_state ON processed_items (state);
