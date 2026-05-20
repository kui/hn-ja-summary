ALTER TABLE feed_items
ADD COLUMN hn_posted_at_ms INTEGER;

ALTER TABLE feed_items
ADD COLUMN comment_count INTEGER;

ALTER TABLE feed_items
ADD COLUMN points INTEGER;

ALTER TABLE feed_items
ADD COLUMN comments_used INTEGER;

ALTER TABLE feed_items
ADD COLUMN article_chars INTEGER;

ALTER TABLE feed_items
ADD COLUMN article_fetch_method TEXT;

ALTER TABLE feed_items
ADD COLUMN input_tokens INTEGER;

ALTER TABLE feed_items
ADD COLUMN output_tokens INTEGER;

ALTER TABLE feed_items
ADD COLUMN updated_at_ms INTEGER;
