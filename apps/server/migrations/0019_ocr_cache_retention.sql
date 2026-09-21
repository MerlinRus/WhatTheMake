ALTER TABLE wtm_ocr_provider_cache ADD COLUMN expires_at timestamptz;

-- Preserve original age: rollout must not renew existing cached OCR text.
UPDATE wtm_ocr_provider_cache
SET expires_at = created_at + interval '7 days';

ALTER TABLE wtm_ocr_provider_cache
  ALTER COLUMN expires_at SET NOT NULL,
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '7 days');

CREATE INDEX wtm_ocr_provider_cache_expiry_idx
  ON wtm_ocr_provider_cache (expires_at, cache_key);

DELETE FROM wtm_ocr_provider_cache WHERE expires_at <= now();

COMMENT ON COLUMN wtm_ocr_provider_cache.expires_at IS
  'Shared OCR result becomes unavailable after seven days; expired rows are physically purged in bounded batches on cache writes.';
