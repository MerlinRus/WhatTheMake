CREATE TABLE wtm_account_recovery_codes (
  account_id uuid PRIMARY KEY REFERENCES wtm_accounts(id) ON DELETE CASCADE,
  code_hash char(64) NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE wtm_account_recovery_codes IS
  'One offline recovery capability per account. Only a SHA-256 digest is stored; rotation replaces it and a successful password reset consumes it.';
