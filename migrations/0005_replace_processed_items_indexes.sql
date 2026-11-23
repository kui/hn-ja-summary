CREATE INDEX IF NOT EXISTS idx_processed_items_updated_at_ms ON processed_items (updated_at_ms DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_processed_items_state_updated_at_ms ON processed_items (state, updated_at_ms DESC, id DESC);

DROP INDEX IF EXISTS idx_processed_items_state;
