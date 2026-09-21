CREATE TABLE wtm_provider_budget_state (
  provider text PRIMARY KEY CHECK (provider IN ('GOOGLE_VISION', 'DEEPSEEK', 'UPCITEMDB')),
  last_reserved_at timestamptz
);

CREATE TABLE wtm_provider_budget_days (
  budget_day date NOT NULL,
  provider text NOT NULL REFERENCES wtm_provider_budget_state(provider),
  request_limit integer NOT NULL CHECK (request_limit BETWEEN 0 AND 1000000),
  admitted_count integer NOT NULL DEFAULT 0 CHECK (admitted_count >= 0 AND admitted_count <= 1000000),
  PRIMARY KEY (budget_day, provider)
);

CREATE TABLE wtm_provider_budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_day date NOT NULL,
  provider text NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  outcome text CHECK (outcome IN (
    'SUCCEEDED', 'ABORTED', 'TIMEOUT', 'AUTHENTICATION_FAILED', 'PERMISSION_DENIED',
    'RATE_LIMITED', 'INVALID_REQUEST', 'INVALID_RESPONSE', 'PROVIDER_REJECTED', 'PROVIDER_UNAVAILABLE'
  )),
  duration_ms integer CHECK (duration_ms BETWEEN 0 AND 3600000),
  FOREIGN KEY (budget_day, provider) REFERENCES wtm_provider_budget_days(budget_day, provider),
  CHECK ((completed_at IS NULL AND outcome IS NULL AND duration_ms IS NULL)
    OR (completed_at IS NOT NULL AND outcome IS NOT NULL AND duration_ms IS NOT NULL))
);
CREATE INDEX wtm_provider_budget_reservations_day_idx
  ON wtm_provider_budget_reservations (budget_day, provider, id);

COMMENT ON TABLE wtm_provider_budget_days IS
  'Persistent invocation admission quotas; not currency or provider billing. Current-day limits may decrease but cannot increase until the next UTC day.';
COMMENT ON TABLE wtm_provider_budget_reservations IS
  'Conservative charged admissions: failed or unresolved requests never refund quota. No user identity, input, keys, output or content hashes.';
