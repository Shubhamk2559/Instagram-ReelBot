-- ===== Instagram connection: token lifecycle + health =====
ALTER TABLE instagram_accounts
  ADD COLUMN IF NOT EXISTS token_refreshed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_refresh_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_used_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error              TEXT;

-- Long-lived tokens last ~60 days, so issue time = expiry - 60 days (fallback: connected_at).
UPDATE instagram_accounts
SET token_refreshed_at = COALESCE(token_expires_at - interval '60 days', connected_at)
WHERE token_refreshed_at IS NULL;

-- ===== Reel job state machine =====
-- scheduled -> publishing (creating container) -> container_created (container exists, waiting for Instagram)
--           -> publish_requested (media_publish sent, NEVER re-sent) -> published | failed
ALTER TABLE reels DROP CONSTRAINT IF EXISTS reels_status_check;
ALTER TABLE reels ADD CONSTRAINT reels_status_check
  CHECK (status IN ('queued', 'scheduled', 'publishing', 'container_created', 'publish_requested', 'published', 'failed'));

-- A container / media id can belong to only one job: hard stop against double publishing.
CREATE UNIQUE INDEX IF NOT EXISTS reels_ig_container_unique ON reels (ig_container_id) WHERE ig_container_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reels_ig_media_unique ON reels (ig_media_id) WHERE ig_media_id IS NOT NULL;

-- Fast lookups for "is this account busy" and stale-job recovery.
CREATE INDEX IF NOT EXISTS reels_inflight_idx ON reels (instagram_account_id, updated_at)
  WHERE status IN ('publishing', 'container_created', 'publish_requested');
