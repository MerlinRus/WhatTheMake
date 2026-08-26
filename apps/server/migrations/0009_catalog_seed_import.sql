CREATE TABLE wtm_catalog_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_key text NOT NULL UNIQUE,
  dataset_id text NOT NULL,
  dataset_version text NOT NULL,
  manifest_sha256 char(64) NOT NULL,
  source_label text NOT NULL,
  source_uri text NOT NULL,
  source_license_name text NOT NULL,
  source_license_uri text NOT NULL,
  source_attribution text NOT NULL,
  source_rights_status text NOT NULL,
  source_retrieved_at timestamptz NOT NULL,
  status text NOT NULL,
  total_count integer NOT NULL,
  published_count integer NOT NULL,
  quarantined_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  rolled_back_at timestamptz,
  CONSTRAINT wtm_catalog_import_batches_dataset_version_unique
    UNIQUE (dataset_id, dataset_version),
  CONSTRAINT wtm_catalog_import_batches_import_key_valid CHECK (
    length(import_key) BETWEEN 3 AND 220
  ),
  CONSTRAINT wtm_catalog_import_batches_dataset_id_valid CHECK (
    dataset_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    AND length(dataset_id) <= 100
  ),
  CONSTRAINT wtm_catalog_import_batches_dataset_version_valid CHECK (
    dataset_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
  ),
  CONSTRAINT wtm_catalog_import_batches_manifest_sha_valid CHECK (
    manifest_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT wtm_catalog_import_batches_source_fields_valid CHECK (
    length(btrim(source_label)) BETWEEN 1 AND 500
    AND source_uri ~ '^https://'
    AND length(source_uri) <= 2048
    AND length(btrim(source_license_name)) BETWEEN 1 AND 200
    AND source_license_uri ~ '^https://'
    AND length(source_license_uri) <= 2048
    AND length(btrim(source_attribution)) BETWEEN 1 AND 1000
  ),
  CONSTRAINT wtm_catalog_import_batches_rights_valid CHECK (
    source_rights_status IN ('ALLOWED', 'UNKNOWN', 'RESTRICTED')
  ),
  CONSTRAINT wtm_catalog_import_batches_status_valid CHECK (
    status IN ('PUBLISHED', 'QUARANTINED', 'ROLLED_BACK')
  ),
  CONSTRAINT wtm_catalog_import_batches_counts_valid CHECK (
    total_count >= 0
    AND published_count >= 0
    AND quarantined_count >= 0
    AND published_count + quarantined_count = total_count
  ),
  CONSTRAINT wtm_catalog_import_batches_timestamps_valid CHECK (
    (
      status = 'PUBLISHED'
      AND published_at IS NOT NULL
      AND rolled_back_at IS NULL
    )
    OR (
      status = 'QUARANTINED'
      AND published_at IS NULL
      AND rolled_back_at IS NULL
    )
    OR (
      status = 'ROLLED_BACK'
      AND rolled_back_at IS NOT NULL
    )
  )
);

CREATE TABLE wtm_catalog_import_items (
  batch_id uuid NOT NULL REFERENCES wtm_catalog_import_batches(id),
  row_number integer NOT NULL,
  source_record_id text,
  row_sha256 char(64) NOT NULL,
  input_gtin text,
  gtin14 char(14),
  source_value varchar(14),
  format text,
  status text NOT NULL,
  quarantine_code text,
  product_family_id uuid REFERENCES wtm_product_families(id),
  product_variant_id uuid REFERENCES wtm_product_variants(id),
  provenance_id uuid REFERENCES wtm_catalog_provenance(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  rolled_back_at timestamptz,
  PRIMARY KEY (batch_id, row_number),
  CONSTRAINT wtm_catalog_import_items_row_number_valid CHECK (row_number > 0),
  CONSTRAINT wtm_catalog_import_items_source_record_id_valid CHECK (
    source_record_id IS NULL
    OR length(btrim(source_record_id)) BETWEEN 1 AND 500
  ),
  CONSTRAINT wtm_catalog_import_items_row_sha_valid CHECK (
    row_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT wtm_catalog_import_items_input_gtin_valid CHECK (
    input_gtin IS NULL OR length(input_gtin) BETWEEN 1 AND 100
  ),
  CONSTRAINT wtm_catalog_import_items_gtin_valid CHECK (
    (
      gtin14 IS NULL
      AND source_value IS NULL
      AND format IS NULL
    )
    OR (
      gtin14 ~ '^[0-9]{14}$'
      AND source_value ~ '^[0-9]+$'
      AND length(source_value) IN (8, 12, 13, 14)
      AND (
        (format = 'EAN_8' AND length(source_value) = 8)
        OR (format = 'UPC_A' AND length(source_value) = 12)
        OR (format = 'EAN_13' AND length(source_value) = 13)
        OR (format = 'GTIN_14' AND length(source_value) = 14)
      )
      AND gtin14 = lpad(source_value, 14, '0')
    )
  ),
  CONSTRAINT wtm_catalog_import_items_status_valid CHECK (
    status IN ('PUBLISHED', 'QUARANTINED', 'ROLLED_BACK')
  ),
  CONSTRAINT wtm_catalog_import_items_quarantine_code_valid CHECK (
    quarantine_code IS NULL
    OR quarantine_code IN (
      'INVALID_ROW',
      'INVALID_GTIN',
      'DUPLICATE_SOURCE_RECORD_ID',
      'DUPLICATE_GTIN',
      'RIGHTS_NOT_ALLOWED',
      'GTIN_CONFLICT'
    )
  ),
  CONSTRAINT wtm_catalog_import_items_state_valid CHECK (
    (
      status = 'PUBLISHED'
      AND quarantine_code IS NULL
      AND gtin14 IS NOT NULL
      AND product_family_id IS NOT NULL
      AND product_variant_id IS NOT NULL
      AND provenance_id IS NOT NULL
      AND rolled_back_at IS NULL
    )
    OR (
      status = 'QUARANTINED'
      AND quarantine_code IS NOT NULL
      AND product_family_id IS NULL
      AND product_variant_id IS NULL
      AND provenance_id IS NULL
      AND rolled_back_at IS NULL
    )
    OR (
      status = 'ROLLED_BACK'
      AND rolled_back_at IS NOT NULL
    )
  )
);

CREATE INDEX wtm_catalog_import_items_gtin_idx
  ON wtm_catalog_import_items (gtin14, batch_id)
  WHERE gtin14 IS NOT NULL;

CREATE INDEX wtm_catalog_import_items_variant_idx
  ON wtm_catalog_import_items (product_variant_id)
  WHERE product_variant_id IS NOT NULL;

CREATE TABLE wtm_catalog_import_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES wtm_catalog_import_batches(id),
  event_kind text NOT NULL,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wtm_catalog_import_events_kind_valid CHECK (
    event_kind IN (
      'PUBLISHED',
      'QUARANTINED',
      'IDEMPOTENT_REPLAY',
      'VERSION_CONFLICT',
      'ROLLED_BACK',
      'ROLLBACK_REPLAY',
      'ROLLBACK_CONFLICT'
    )
  ),
  CONSTRAINT wtm_catalog_import_events_details_object CHECK (
    jsonb_typeof(details) = 'object'
  )
);

CREATE INDEX wtm_catalog_import_events_batch_idx
  ON wtm_catalog_import_events (batch_id, id);

COMMENT ON TABLE wtm_catalog_import_batches IS
  'Immutable, versioned controlled catalog imports and their publication state.';

COMMENT ON TABLE wtm_catalog_import_events IS
  'Append-only audit trail for publish, replay, conflict, and rollback commands.';
