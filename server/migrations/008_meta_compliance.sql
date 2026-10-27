-- Meta platform compliance: app-scoped id (used by deauthorize / data-deletion callbacks) + deletion request log.
ALTER TABLE instagram_accounts ADD COLUMN IF NOT EXISTS app_scoped_id TEXT;
CREATE INDEX IF NOT EXISTS instagram_accounts_app_scoped_idx ON instagram_accounts (app_scoped_id);

CREATE TABLE IF NOT EXISTS deletion_requests (
  code         TEXT PRIMARY KEY,
  ig_user_id   TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
