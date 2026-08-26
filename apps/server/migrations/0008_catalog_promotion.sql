CREATE TABLE wtm_catalog_promotion_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gtin14 varchar(14) NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'WAITING_FOR_MATCH',
  conflict_reason text,
  selected_fingerprint char(64),
  product_variant_id uuid REFERENCES wtm_product_variants(id),
  resolution_kind text,
  moderated_by_account_id uuid REFERENCES wtm_accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT wtm_catalog_promotion_cases_gtin14_valid CHECK (
    gtin14 ~ '^[0-9]{14}$'
  ),
  CONSTRAINT wtm_catalog_promotion_cases_status_valid CHECK (
    status IN ('WAITING_FOR_MATCH', 'NEEDS_MODERATION', 'PUBLISHED')
  ),
  CONSTRAINT wtm_catalog_promotion_cases_conflict_reason_valid CHECK (
    conflict_reason IS NULL
    OR conflict_reason IN ('IDENTITY_MISMATCH', 'CATALOG_GTIN_CONFLICT')
  ),
  CONSTRAINT wtm_catalog_promotion_cases_fingerprint_valid CHECK (
    selected_fingerprint IS NULL OR selected_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT wtm_catalog_promotion_cases_resolution_kind_valid CHECK (
    resolution_kind IS NULL OR resolution_kind IN ('AUTO_QUORUM', 'ADMIN')
  ),
  CONSTRAINT wtm_catalog_promotion_cases_published_valid CHECK (
    status <> 'PUBLISHED'
    OR (
      selected_fingerprint IS NOT NULL
      AND product_variant_id IS NOT NULL
      AND resolution_kind IS NOT NULL
      AND published_at IS NOT NULL
      AND conflict_reason IS NULL
    )
  ),
  CONSTRAINT wtm_catalog_promotion_cases_admin_resolution_valid CHECK (
    (resolution_kind = 'ADMIN' AND moderated_by_account_id IS NOT NULL)
    OR (resolution_kind IS DISTINCT FROM 'ADMIN' AND moderated_by_account_id IS NULL)
  ),
  CONSTRAINT wtm_catalog_promotion_cases_updated_after_create CHECK (
    updated_at >= created_at
  )
);

CREATE TABLE wtm_product_observation_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_case_id uuid NOT NULL
    REFERENCES wtm_catalog_promotion_cases(id) ON DELETE CASCADE,
  observation_id uuid NOT NULL UNIQUE
    REFERENCES wtm_product_observations(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES wtm_accounts(id) ON DELETE CASCADE,
  fingerprint char(64) NOT NULL,
  brand_name text NOT NULL,
  family_name text NOT NULL,
  variant_name text NOT NULL,
  shade_name text,
  net_quantity_value numeric(12, 4),
  net_quantity_unit text,
  waterproof boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wtm_product_observation_confirmations_account_case_unique
    UNIQUE (promotion_case_id, account_id),
  CONSTRAINT wtm_product_observation_confirmations_fingerprint_valid CHECK (
    fingerprint ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT wtm_product_observation_confirmations_brand_name_valid CHECK (
    length(btrim(brand_name)) BETWEEN 1 AND 200
  ),
  CONSTRAINT wtm_product_observation_confirmations_family_name_valid CHECK (
    length(btrim(family_name)) BETWEEN 1 AND 300
  ),
  CONSTRAINT wtm_product_observation_confirmations_variant_name_valid CHECK (
    length(btrim(variant_name)) BETWEEN 1 AND 300
  ),
  CONSTRAINT wtm_product_observation_confirmations_shade_name_valid CHECK (
    shade_name IS NULL OR length(btrim(shade_name)) BETWEEN 1 AND 200
  ),
  CONSTRAINT wtm_product_observation_confirmations_net_quantity_valid CHECK (
    (
      net_quantity_value IS NULL
      AND net_quantity_unit IS NULL
    )
    OR (
      net_quantity_value > 0
      AND net_quantity_unit IN ('MILLILITER', 'GRAM')
    )
  )
);

CREATE INDEX wtm_product_observation_confirmations_case_fingerprint_idx
  ON wtm_product_observation_confirmations (
    promotion_case_id,
    fingerprint,
    account_id
  );

COMMENT ON TABLE wtm_catalog_promotion_cases IS
  'GTIN-scoped no-winner promotion state; conflicts require explicit moderation.';

COMMENT ON TABLE wtm_product_observation_confirmations IS
  'One catalog identity confirmation per account and GTIN; session tokens never count.';
