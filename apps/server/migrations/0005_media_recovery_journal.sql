CREATE TABLE wtm_media_recovery_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_kind text NOT NULL,
  resource_id uuid NOT NULL,
  collection_id uuid REFERENCES wtm_media_collections(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'PENDING',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT wtm_media_recovery_jobs_operation_valid CHECK (
    operation_kind IN ('ABANDONED_UPLOAD', 'DELETE_ASSET')
  ),
  CONSTRAINT wtm_media_recovery_jobs_status_valid CHECK (
    status IN ('PENDING', 'PROCESSING', 'COMPLETED')
  ),
  CONSTRAINT wtm_media_recovery_jobs_attempts_valid CHECK (attempts >= 0),
  CONSTRAINT wtm_media_recovery_jobs_error_code_valid CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,64}$'
  ),
  CONSTRAINT wtm_media_recovery_jobs_state_valid CHECK (
    (
      status = 'PENDING'
      AND locked_at IS NULL
      AND completed_at IS NULL
    )
    OR
    (
      status = 'PROCESSING'
      AND locked_at IS NOT NULL
      AND completed_at IS NULL
    )
    OR
    (
      status = 'COMPLETED'
      AND locked_at IS NULL
      AND completed_at IS NOT NULL
    )
  ),
  UNIQUE (operation_kind, resource_id)
);

CREATE INDEX wtm_media_recovery_jobs_claim_idx
  ON wtm_media_recovery_jobs (available_at, created_at, id)
  WHERE status IN ('PENDING', 'PROCESSING');

COMMENT ON TABLE wtm_media_recovery_jobs IS
  'Crash-recovery journal for private media upload and physical deletion.';
