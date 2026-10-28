-- Session-ID (unofficial) login has been removed. Only the official Instagram Login (OAuth) is supported.
-- Delete any leftover session-ID accounts (and, via ON DELETE CASCADE, their waiting posts and stored cookies).
DELETE FROM instagram_accounts WHERE auth_type = 'session' OR instagram_user_id LIKE 'pending-%';

ALTER TABLE instagram_accounts DROP CONSTRAINT IF EXISTS instagram_accounts_auth_type_check;
ALTER TABLE instagram_accounts DROP COLUMN IF EXISTS auth_type;
ALTER TABLE instagram_accounts DROP CONSTRAINT IF EXISTS instagram_accounts_status_check;
ALTER TABLE instagram_accounts ADD CONSTRAINT instagram_accounts_status_check
  CHECK (status IN ('active', 'expired', 'revoked'));
