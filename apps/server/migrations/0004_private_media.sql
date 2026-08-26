CREATE TABLE wtm_media_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_kind text NOT NULL,
  guest_id uuid REFERENCES wtm_guests(id) ON DELETE CASCADE,
  account_id uuid REFERENCES wtm_accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT wtm_media_collections_owner_valid CHECK (
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
  CONSTRAINT wtm_media_collections_deleted_after_create CHECK (
    deleted_at IS NULL OR deleted_at >= created_at
  )
);

CREATE TABLE wtm_media_assets (
  id uuid PRIMARY KEY,
  collection_id uuid NOT NULL REFERENCES wtm_media_collections(id) ON DELETE CASCADE,
  role text NOT NULL,
  media_type text NOT NULL,
  byte_size integer NOT NULL,
  sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT wtm_media_assets_role_valid CHECK (
    role IN ('FRONT', 'INGREDIENTS', 'CLAIMS', 'BARCODE', 'PRICE_TAG')
  ),
  CONSTRAINT wtm_media_assets_media_type_valid CHECK (
    media_type IN ('image/jpeg', 'image/png', 'image/webp')
  ),
  CONSTRAINT wtm_media_assets_byte_size_valid CHECK (
    byte_size BETWEEN 1 AND 8388608
  ),
  CONSTRAINT wtm_media_assets_sha256_valid CHECK (
    sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT wtm_media_assets_deleted_after_create CHECK (
    deleted_at IS NULL OR deleted_at >= created_at
  )
);

CREATE INDEX wtm_media_collections_guest_idx
  ON wtm_media_collections (guest_id)
  WHERE deleted_at IS NULL AND owner_kind = 'GUEST';

CREATE INDEX wtm_media_collections_account_idx
  ON wtm_media_collections (account_id)
  WHERE deleted_at IS NULL AND owner_kind = 'ACCOUNT';

CREATE INDEX wtm_media_assets_collection_active_idx
  ON wtm_media_assets (collection_id, created_at, id)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE wtm_media_assets IS
  'Private image metadata only; binary objects remain outside PostgreSQL.';
