CREATE TABLE wtm_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_normalized text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wtm_accounts_email_normalized_unique UNIQUE (email_normalized),
  CONSTRAINT wtm_accounts_email_is_normalized CHECK (
    email_normalized = lower(btrim(email_normalized))
  ),
  CONSTRAINT wtm_accounts_status_valid CHECK (
    status IN ('ACTIVE', 'BLOCKED', 'DELETED')
  )
);

CREATE TABLE wtm_guests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  claimed_by_account_id uuid REFERENCES wtm_accounts(id) ON DELETE SET NULL,
  CONSTRAINT wtm_guests_deleted_after_create CHECK (
    deleted_at IS NULL OR deleted_at >= created_at
  )
);

CREATE TABLE wtm_identity_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash char(64) NOT NULL,
  subject_kind text NOT NULL,
  guest_id uuid REFERENCES wtm_guests(id) ON DELETE CASCADE,
  account_id uuid REFERENCES wtm_accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT wtm_identity_sessions_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT wtm_identity_sessions_subject_valid CHECK (
    (
      subject_kind = 'GUEST'
      AND guest_id IS NOT NULL
      AND account_id IS NULL
      AND expires_at IS NULL
    )
    OR
    (
      subject_kind = 'ACCOUNT'
      AND guest_id IS NULL
      AND account_id IS NOT NULL
      AND expires_at IS NOT NULL
    )
  ),
  CONSTRAINT wtm_identity_sessions_revoked_after_create CHECK (
    revoked_at IS NULL OR revoked_at >= created_at
  )
);

CREATE INDEX wtm_identity_sessions_guest_active_idx
  ON wtm_identity_sessions (guest_id)
  WHERE revoked_at IS NULL AND subject_kind = 'GUEST';

CREATE INDEX wtm_identity_sessions_account_active_idx
  ON wtm_identity_sessions (account_id, expires_at)
  WHERE revoked_at IS NULL AND subject_kind = 'ACCOUNT';

COMMENT ON TABLE wtm_guests IS
  'Capability-owned guest principals retained until explicit deletion.';

COMMENT ON COLUMN wtm_identity_sessions.token_hash IS
  'SHA-256 digest of an opaque cookie token; raw token is never persisted.';
