ALTER TABLE users ADD COLUMN password_hash TEXT NOT NULL;

CREATE TABLE sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE oauth_states (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE instagram_accounts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instagram_user_id       TEXT NOT NULL UNIQUE,
  username                TEXT NOT NULL,
  account_type            TEXT,
  access_token_encrypted  TEXT NOT NULL,
  token_expires_at        TIMESTAMPTZ,
  scopes                  TEXT,
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  connected_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX instagram_accounts_user_id_idx ON instagram_accounts (user_id);

CREATE TRIGGER instagram_accounts_set_updated_at
  BEFORE UPDATE ON instagram_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
