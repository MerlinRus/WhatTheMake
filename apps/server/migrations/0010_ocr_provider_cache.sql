CREATE TABLE wtm_ocr_provider_cache (
  cache_key char(64) PRIMARY KEY,
  result_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wtm_ocr_provider_cache_key_valid CHECK (
    cache_key ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT wtm_ocr_provider_cache_result_bounded CHECK (
    octet_length(result_text) <= 4194304
  )
);

COMMENT ON TABLE wtm_ocr_provider_cache IS
  'Successful validated OCR text keyed by versioned request digest; images are never stored.';
