-- Instagram accounts connected with a Session ID (unofficial, posted by the reelbot worker),
-- stored next to the official OAuth accounts. 'pending' = Session ID saved, worker is verifying it.
ALTER TABLE instagram_accounts ADD COLUMN IF NOT EXISTS auth_type TEXT NOT NULL DEFAULT 'oauth';

DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'instagram_accounts'::regclass AND contype = 'c' LOOP
    EXECUTE format('ALTER TABLE instagram_accounts DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE instagram_accounts ADD CONSTRAINT instagram_accounts_status_check
  CHECK (status IN ('active', 'expired', 'revoked', 'pending'));
ALTER TABLE instagram_accounts ADD CONSTRAINT instagram_accounts_auth_type_check
  CHECK (auth_type IN ('oauth', 'session'));
