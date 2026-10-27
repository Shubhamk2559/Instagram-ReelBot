CREATE TABLE library (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_url       TEXT NOT NULL,
  video_public_id TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX library_user_idx ON library (user_id, created_at);

CREATE TABLE queue_settings (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  caption         TEXT NOT NULL DEFAULT '',
  cover_url       TEXT,
  cover_public_id TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
