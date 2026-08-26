CREATE TABLE wtm_system_metadata (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE wtm_system_metadata IS
  'Non-secret application metadata used for operational coordination.';

INSERT INTO wtm_system_metadata (key, value)
VALUES ('schema_origin', '{"product":"what-the-make","slice":"A1-A4"}'::jsonb)
ON CONFLICT (key) DO NOTHING;

