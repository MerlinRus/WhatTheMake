CREATE TABLE wtm_catalog_provenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind text NOT NULL,
  source_label text NOT NULL,
  source_uri text,
  source_record_id text,
  observed_at timestamptz,
  rights_status text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wtm_catalog_provenance_source_kind_valid CHECK (
    source_kind IN (
      'MANUFACTURER',
      'REGULATOR',
      'CONTROLLED_IMPORT',
      'USER_OBSERVATION',
      'ADMIN'
    )
  ),
  CONSTRAINT wtm_catalog_provenance_source_label_valid CHECK (
    length(btrim(source_label)) BETWEEN 1 AND 500
  ),
  CONSTRAINT wtm_catalog_provenance_source_uri_valid CHECK (
    source_uri IS NULL OR length(source_uri) BETWEEN 1 AND 2048
  ),
  CONSTRAINT wtm_catalog_provenance_source_record_id_valid CHECK (
    source_record_id IS NULL OR length(source_record_id) BETWEEN 1 AND 500
  ),
  CONSTRAINT wtm_catalog_provenance_rights_status_valid CHECK (
    rights_status IN ('ALLOWED', 'UNKNOWN', 'RESTRICTED')
  )
);

CREATE TABLE wtm_product_families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  brand_name text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  provenance_id uuid NOT NULL REFERENCES wtm_catalog_provenance(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  archived_at timestamptz,
  CONSTRAINT wtm_product_families_category_valid CHECK (category = 'MASCARA'),
  CONSTRAINT wtm_product_families_brand_name_valid CHECK (
    length(btrim(brand_name)) BETWEEN 1 AND 200
  ),
  CONSTRAINT wtm_product_families_name_valid CHECK (
    length(btrim(name)) BETWEEN 1 AND 300
  ),
  CONSTRAINT wtm_product_families_status_valid CHECK (
    status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')
  ),
  CONSTRAINT wtm_product_families_status_timestamps_valid CHECK (
    (
      status = 'DRAFT'
      AND published_at IS NULL
      AND archived_at IS NULL
    )
    OR (
      status = 'PUBLISHED'
      AND published_at IS NOT NULL
      AND archived_at IS NULL
    )
    OR (
      status = 'ARCHIVED'
      AND archived_at IS NOT NULL
    )
  ),
  CONSTRAINT wtm_product_families_updated_after_create CHECK (
    updated_at >= created_at
  )
);

CREATE TABLE wtm_product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES wtm_product_families(id),
  name text NOT NULL,
  shade_name text,
  net_quantity_value numeric(12, 4),
  net_quantity_unit text,
  waterproof boolean,
  status text NOT NULL DEFAULT 'DRAFT',
  provenance_id uuid NOT NULL REFERENCES wtm_catalog_provenance(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  archived_at timestamptz,
  CONSTRAINT wtm_product_variants_name_valid CHECK (
    length(btrim(name)) BETWEEN 1 AND 300
  ),
  CONSTRAINT wtm_product_variants_shade_name_valid CHECK (
    shade_name IS NULL OR length(btrim(shade_name)) BETWEEN 1 AND 200
  ),
  CONSTRAINT wtm_product_variants_net_quantity_valid CHECK (
    (
      net_quantity_value IS NULL
      AND net_quantity_unit IS NULL
    )
    OR (
      net_quantity_value > 0
      AND net_quantity_unit IN ('MILLILITER', 'GRAM')
    )
  ),
  CONSTRAINT wtm_product_variants_status_valid CHECK (
    status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')
  ),
  CONSTRAINT wtm_product_variants_status_timestamps_valid CHECK (
    (
      status = 'DRAFT'
      AND published_at IS NULL
      AND archived_at IS NULL
    )
    OR (
      status = 'PUBLISHED'
      AND published_at IS NOT NULL
      AND archived_at IS NULL
    )
    OR (
      status = 'ARCHIVED'
      AND archived_at IS NOT NULL
    )
  ),
  CONSTRAINT wtm_product_variants_updated_after_create CHECK (
    updated_at >= created_at
  ),
  CONSTRAINT wtm_product_variants_id_family_unique UNIQUE (id, family_id)
);

CREATE INDEX wtm_product_variants_family_idx
  ON wtm_product_variants (family_id, status, id);

CREATE TABLE wtm_product_barcodes (
  gtin14 char(14) PRIMARY KEY,
  source_value varchar(14) NOT NULL,
  format text NOT NULL,
  variant_id uuid NOT NULL REFERENCES wtm_product_variants(id),
  provenance_id uuid NOT NULL REFERENCES wtm_catalog_provenance(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wtm_product_barcodes_gtin14_valid CHECK (
    gtin14 ~ '^[0-9]{14}$'
  ),
  CONSTRAINT wtm_product_barcodes_source_value_valid CHECK (
    source_value ~ '^[0-9]+$'
    AND length(source_value) IN (8, 12, 13, 14)
  ),
  CONSTRAINT wtm_product_barcodes_format_valid CHECK (
    (format = 'EAN_8' AND length(source_value) = 8)
    OR (format = 'UPC_A' AND length(source_value) = 12)
    OR (format = 'EAN_13' AND length(source_value) = 13)
    OR (format = 'GTIN_14' AND length(source_value) = 14)
  ),
  CONSTRAINT wtm_product_barcodes_canonical_valid CHECK (
    gtin14 = lpad(source_value, 14, '0')
  )
);

CREATE INDEX wtm_product_barcodes_variant_idx
  ON wtm_product_barcodes (variant_id, gtin14);

CREATE TABLE wtm_formula_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES wtm_product_variants(id),
  revision_number integer NOT NULL,
  inci_text text NOT NULL,
  status text NOT NULL DEFAULT 'CURRENT',
  provenance_id uuid NOT NULL REFERENCES wtm_catalog_provenance(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  CONSTRAINT wtm_formula_revisions_variant_number_unique
    UNIQUE (variant_id, revision_number),
  CONSTRAINT wtm_formula_revisions_id_variant_unique UNIQUE (id, variant_id),
  CONSTRAINT wtm_formula_revisions_number_positive CHECK (revision_number > 0),
  CONSTRAINT wtm_formula_revisions_inci_valid CHECK (
    length(btrim(inci_text)) BETWEEN 1 AND 30000
  ),
  CONSTRAINT wtm_formula_revisions_status_valid CHECK (
    status IN ('CURRENT', 'SUPERSEDED')
  ),
  CONSTRAINT wtm_formula_revisions_status_timestamp_valid CHECK (
    (status = 'CURRENT' AND superseded_at IS NULL)
    OR (status = 'SUPERSEDED' AND superseded_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX wtm_formula_revisions_one_current_idx
  ON wtm_formula_revisions (variant_id)
  WHERE status = 'CURRENT';

CREATE TABLE wtm_product_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES wtm_product_variants(id),
  formula_revision_id uuid,
  claim_kind text NOT NULL,
  claim_text text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  provenance_id uuid NOT NULL REFERENCES wtm_catalog_provenance(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  withdrawn_at timestamptz,
  CONSTRAINT wtm_product_claims_formula_variant_fk
    FOREIGN KEY (formula_revision_id, variant_id)
    REFERENCES wtm_formula_revisions (id, variant_id),
  CONSTRAINT wtm_product_claims_kind_valid CHECK (
    claim_kind IN (
      'VOLUME',
      'LENGTH',
      'SEPARATION',
      'NATURAL_LOOK',
      'WATERPROOF',
      'EASY_REMOVAL',
      'OTHER'
    )
  ),
  CONSTRAINT wtm_product_claims_text_valid CHECK (
    length(btrim(claim_text)) BETWEEN 1 AND 4000
  ),
  CONSTRAINT wtm_product_claims_status_valid CHECK (
    status IN ('DRAFT', 'PUBLISHED', 'WITHDRAWN')
  ),
  CONSTRAINT wtm_product_claims_status_timestamps_valid CHECK (
    (
      status = 'DRAFT'
      AND published_at IS NULL
      AND withdrawn_at IS NULL
    )
    OR (
      status = 'PUBLISHED'
      AND published_at IS NOT NULL
      AND withdrawn_at IS NULL
    )
    OR (
      status = 'WITHDRAWN'
      AND withdrawn_at IS NOT NULL
    )
  ),
  CONSTRAINT wtm_product_claims_updated_after_create CHECK (
    updated_at >= created_at
  )
);

CREATE INDEX wtm_product_claims_variant_idx
  ON wtm_product_claims (variant_id, status, claim_kind, id);

COMMENT ON TABLE wtm_product_families IS
  'Shared commercial product identity; never a comparison target by itself.';

COMMENT ON TABLE wtm_product_variants IS
  'Exact purchasable product identity used as the comparison target.';

COMMENT ON TABLE wtm_formula_revisions IS
  'Immutable INCI history; every change creates a new current revision.';
