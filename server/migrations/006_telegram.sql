ALTER TABLE library ALTER COLUMN video_url DROP NOT NULL;
ALTER TABLE library ALTER COLUMN video_public_id DROP NOT NULL;
ALTER TABLE library ADD COLUMN tg_file_id TEXT, ADD COLUMN tg_unique_id TEXT, ADD COLUMN tg_size INT;
CREATE UNIQUE INDEX library_tg_unique_idx ON library (user_id, tg_unique_id);

ALTER TABLE reels ALTER COLUMN video_url DROP NOT NULL;
ALTER TABLE reels ALTER COLUMN video_public_id DROP NOT NULL;
ALTER TABLE reels ADD COLUMN tg_file_id TEXT;

ALTER TABLE queue_settings ADD COLUMN cover_data BYTEA, ADD COLUMN cover_token TEXT;
CREATE UNIQUE INDEX queue_settings_cover_token_idx ON queue_settings (cover_token);

CREATE TABLE telegram_links (
  chat_id BIGINT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
