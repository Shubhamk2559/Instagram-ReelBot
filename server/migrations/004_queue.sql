ALTER TABLE reels ALTER COLUMN scheduled_at SET DEFAULT now();

DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'reels'::regclass AND contype = 'c' LOOP
    EXECUTE format('ALTER TABLE reels DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE reels ADD CONSTRAINT reels_status_check
  CHECK (status IN ('queued', 'scheduled', 'publishing', 'published', 'failed'));

CREATE INDEX reels_queue_idx ON reels (created_at) WHERE status = 'queued';

CREATE TABLE queue_runs (
  slot_key TEXT PRIMARY KEY,
  ran_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
