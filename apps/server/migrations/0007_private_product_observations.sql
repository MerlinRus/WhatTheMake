CREATE UNIQUE INDEX wtm_media_assets_collection_role_active_unique
  ON wtm_media_assets (collection_id, role)
  WHERE deleted_at IS NULL;

CREATE TABLE wtm_product_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_kind text NOT NULL,
  guest_id uuid REFERENCES wtm_guests(id) ON DELETE CASCADE,
  account_id uuid REFERENCES wtm_accounts(id) ON DELETE CASCADE,
  gtin_value varchar(14) NOT NULL,
  gtin_format text NOT NULL,
  gtin14 varchar(14) NOT NULL,
  media_collection_id uuid NOT NULL UNIQUE
    REFERENCES wtm_media_collections(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wtm_product_observations_owner_valid CHECK (
    (
      owner_kind = 'GUEST'
      AND guest_id IS NOT NULL
      AND account_id IS NULL
    )
    OR
    (
      owner_kind = 'ACCOUNT'
      AND guest_id IS NULL
      AND account_id IS NOT NULL
    )
  ),
  CONSTRAINT wtm_product_observations_gtin_value_valid CHECK (
    gtin_value ~ '^(?:[0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$'
  ),
  CONSTRAINT wtm_product_observations_gtin14_valid CHECK (
    gtin14 ~ '^[0-9]{14}$' AND gtin14 = lpad(gtin_value, 14, '0')
  ),
  CONSTRAINT wtm_product_observations_gtin_format_valid CHECK (
    (gtin_format = 'EAN_8' AND length(gtin_value) = 8)
    OR (gtin_format = 'UPC_A' AND length(gtin_value) = 12)
    OR (gtin_format = 'EAN_13' AND length(gtin_value) = 13)
    OR (gtin_format = 'GTIN_14' AND length(gtin_value) = 14)
  ),
  CONSTRAINT wtm_product_observations_updated_after_create CHECK (
    updated_at >= created_at
  ),
  CONSTRAINT wtm_product_observations_owner_gtin_unique
    UNIQUE NULLS NOT DISTINCT (owner_kind, guest_id, account_id, gtin14)
);

CREATE INDEX wtm_product_observations_guest_active_idx
  ON wtm_product_observations (guest_id, updated_at DESC)
  WHERE owner_kind = 'GUEST';

CREATE INDEX wtm_product_observations_account_active_idx
  ON wtm_product_observations (account_id, updated_at DESC)
  WHERE owner_kind = 'ACCOUNT';

COMMENT ON TABLE wtm_product_observations IS
  'Private owner-scoped captures; never published directly to the global catalog.';
