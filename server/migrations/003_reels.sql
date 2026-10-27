CREATE TABLE reels (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instagram_account_id  UUID NOT NULL REFERENCES instagram_accounts(id) ON DELETE CASCADE,
  video_url             TEXT NOT NULL,
  video_public_id       TEXT NOT NULL,
  cover_url             TEXT,
  cover_public_id       TEXT,
  caption               TEXT NOT NULL DEFAULT '',
  scheduled_at          TIMESTAMPTZ NOT NULL,
  status                TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'publishing', 'published', 'failed')),
  error                 TEXT,
  ig_container_id       TEXT,
  ig_media_id           TEXT,
  published_at          TIMESTAMPTZ,
  attempts              INT NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reels_due_idx ON reels (scheduled_at) WHERE status = 'scheduled';
CREATE INDEX reels_user_idx ON reels (user_id, scheduled_at DESC);

CREATE TRIGGER reels_set_updated_at
  BEFORE UPDATE ON reels
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
