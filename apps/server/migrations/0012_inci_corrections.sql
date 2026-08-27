CREATE TABLE wtm_product_observation_inci_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id uuid NOT NULL
    REFERENCES wtm_product_observations(id) ON DELETE CASCADE,
  revision_number smallint NOT NULL,
  source_kind varchar(30) NOT NULL,
  source_text text NOT NULL,
  source_sha256 char(64) NOT NULL,
  based_on_revision_id uuid,
  author_kind varchar(20) NOT NULL,
  guest_id uuid REFERENCES wtm_guests(id),
  account_id uuid REFERENCES wtm_accounts(id),
  media_asset_id uuid REFERENCES wtm_media_assets(id),
  provider_id varchar(100),
  provider_version varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wtm_product_observation_inci_revision_number_valid CHECK (
    revision_number BETWEEN 1 AND 50
  ),
  CONSTRAINT wtm_product_observation_inci_source_kind_valid CHECK (
    source_kind IN ('OCR', 'USER_TRANSCRIPTION', 'USER_CORRECTION')
  ),
  CONSTRAINT wtm_product_observation_inci_source_text_valid CHECK (
    char_length(source_text) BETWEEN 1 AND 100000
    AND btrim(source_text) <> ''
  ),
  CONSTRAINT wtm_product_observation_inci_source_sha_valid CHECK (
    source_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT wtm_product_observation_inci_author_kind_valid CHECK (
    author_kind IN ('SYSTEM', 'GUEST', 'ACCOUNT')
  ),
  CONSTRAINT wtm_product_observation_inci_author_valid CHECK (
    (
      author_kind = 'SYSTEM'
      AND guest_id IS NULL
      AND account_id IS NULL
    )
    OR (
      author_kind = 'GUEST'
      AND guest_id IS NOT NULL
      AND account_id IS NULL
    )
    OR (
      author_kind = 'ACCOUNT'
      AND guest_id IS NULL
      AND account_id IS NOT NULL
    )
  ),
  CONSTRAINT wtm_product_observation_inci_source_shape_valid CHECK (
    (
      source_kind = 'OCR'
      AND revision_number = 1
      AND based_on_revision_id IS NULL
      AND author_kind = 'SYSTEM'
      AND media_asset_id IS NOT NULL
      AND provider_id IS NOT NULL
      AND provider_version IS NOT NULL
    )
    OR (
      source_kind = 'USER_TRANSCRIPTION'
      AND revision_number = 1
      AND based_on_revision_id IS NULL
      AND author_kind IN ('GUEST', 'ACCOUNT')
      AND media_asset_id IS NULL
      AND provider_id IS NULL
      AND provider_version IS NULL
    )
    OR (
      source_kind = 'USER_CORRECTION'
      AND revision_number > 1
      AND based_on_revision_id IS NOT NULL
      AND author_kind IN ('GUEST', 'ACCOUNT')
      AND media_asset_id IS NULL
      AND provider_id IS NULL
      AND provider_version IS NULL
    )
  ),
  CONSTRAINT wtm_product_observation_inci_provider_valid CHECK (
    (provider_id IS NULL AND provider_version IS NULL)
    OR (
      length(btrim(provider_id)) BETWEEN 1 AND 100
      AND length(btrim(provider_version)) BETWEEN 1 AND 100
    )
  ),
  CONSTRAINT wtm_product_observation_inci_observation_revision_unique
    UNIQUE (observation_id, revision_number),
  CONSTRAINT wtm_product_observation_inci_observation_id_unique
    UNIQUE (observation_id, id),
  CONSTRAINT wtm_product_observation_inci_base_fk
    FOREIGN KEY (observation_id, based_on_revision_id)
    REFERENCES wtm_product_observation_inci_revisions(observation_id, id)
);

CREATE INDEX wtm_product_observation_inci_latest_idx
  ON wtm_product_observation_inci_revisions (
    observation_id,
    revision_number DESC
  );

CREATE FUNCTION wtm_validate_inci_revision_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  observation_owner_kind text;
  observation_guest_id uuid;
  observation_account_id uuid;
  claimed_by_account_id uuid;
  observation_collection_id uuid;
  expected_revision_number integer;
  base_revision_number integer;
  asset_collection_id uuid;
  asset_role text;
  asset_deleted_at timestamptz;
BEGIN
  SELECT
    observation.owner_kind,
    observation.guest_id,
    observation.account_id,
    guest.claimed_by_account_id,
    observation.media_collection_id
  INTO
    observation_owner_kind,
    observation_guest_id,
    observation_account_id,
    claimed_by_account_id,
    observation_collection_id
  FROM wtm_product_observations AS observation
  LEFT JOIN wtm_guests AS guest ON guest.id = observation.guest_id
  WHERE observation.id = NEW.observation_id;

  IF observation_owner_kind IS NULL THEN
    RAISE EXCEPTION 'INCI revision observation does not exist'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.author_kind = 'GUEST' AND (
    observation_owner_kind <> 'GUEST'
    OR NEW.guest_id IS DISTINCT FROM observation_guest_id
  ) THEN
    RAISE EXCEPTION 'INCI revision author does not own observation'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.author_kind = 'ACCOUNT' AND NOT (
    (
      observation_owner_kind = 'ACCOUNT'
      AND NEW.account_id IS NOT DISTINCT FROM observation_account_id
    )
    OR (
      observation_owner_kind = 'GUEST'
      AND NEW.account_id IS NOT DISTINCT FROM claimed_by_account_id
    )
  ) THEN
    RAISE EXCEPTION 'INCI revision author does not own observation'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(MAX(revision_number), 0) + 1
  INTO expected_revision_number
  FROM wtm_product_observation_inci_revisions
  WHERE observation_id = NEW.observation_id;

  IF NEW.revision_number <> expected_revision_number THEN
    RAISE EXCEPTION 'INCI revision numbers must be append-only and sequential'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.source_kind = 'USER_CORRECTION' THEN
    SELECT revision_number
    INTO base_revision_number
    FROM wtm_product_observation_inci_revisions
    WHERE observation_id = NEW.observation_id
      AND id = NEW.based_on_revision_id;

    IF
      base_revision_number IS NULL
      OR base_revision_number >= NEW.revision_number
    THEN
      RAISE EXCEPTION 'INCI correction base revision is invalid'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.source_kind = 'OCR' THEN
    SELECT collection_id, role, deleted_at
    INTO asset_collection_id, asset_role, asset_deleted_at
    FROM wtm_media_assets
    WHERE id = NEW.media_asset_id;

    IF
      asset_collection_id IS DISTINCT FROM observation_collection_id
      OR asset_role IS DISTINCT FROM 'INGREDIENTS'
      OR asset_deleted_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'OCR source must use active ingredients media'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER wtm_product_observation_inci_insert_guard
BEFORE INSERT ON wtm_product_observation_inci_revisions
FOR EACH ROW EXECUTE FUNCTION wtm_validate_inci_revision_insert();

CREATE FUNCTION wtm_reject_inci_revision_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'INCI source revisions are immutable'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER wtm_product_observation_inci_immutable
BEFORE UPDATE ON wtm_product_observation_inci_revisions
FOR EACH ROW EXECUTE FUNCTION wtm_reject_inci_revision_update();

COMMENT ON TABLE wtm_product_observation_inci_revisions IS
  'Private append-only OCR, transcription, and correction evidence for a product observation.';
