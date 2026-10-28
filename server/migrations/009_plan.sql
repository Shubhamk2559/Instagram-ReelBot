-- Per-user posting plan (times / interval / reels per run), editable from the dashboard.
CREATE TABLE IF NOT EXISTS post_plan (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode         TEXT NOT NULL DEFAULT 'times' CHECK (mode IN ('times', 'interval')),
  times        TEXT NOT NULL DEFAULT '10:00,19:00',
  start_time   TEXT NOT NULL DEFAULT '09:00',
  end_time     TEXT NOT NULL DEFAULT '21:00',
  interval_min INT  NOT NULL DEFAULT 120,
  per_run      INT  NOT NULL DEFAULT 1,
  gap_min      INT  NOT NULL DEFAULT 15,
  stagger_min  INT  NOT NULL DEFAULT 3,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hard guarantee: one video can be posted only ONCE per day per user (so never on 2 accounts / twice on one account the same day).
-- Old rows keep NULLs and are not affected.
ALTER TABLE reels
  ADD COLUMN IF NOT EXISTS video_key TEXT,
  ADD COLUMN IF NOT EXISTS post_day  DATE;

CREATE UNIQUE INDEX IF NOT EXISTS reels_user_video_day_unique
  ON reels (user_id, video_key, post_day)
  WHERE video_key IS NOT NULL AND post_day IS NOT NULL;
