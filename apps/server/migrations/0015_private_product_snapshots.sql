CREATE TABLE wtm_private_product_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id uuid NOT NULL REFERENCES wtm_product_observations(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL,
  snapshot_number smallint NOT NULL CHECK (snapshot_number BETWEEN 1 AND 50),
  fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  category text NOT NULL CHECK (category = 'MASCARA'),
  identity_confirmed boolean NOT NULL CHECK (identity_confirmed),
  brand_name varchar(200) NOT NULL CHECK (btrim(brand_name) <> ''),
  family_name varchar(300) NOT NULL CHECK (btrim(family_name) <> ''),
  variant_name varchar(300) NOT NULL CHECK (btrim(variant_name) <> ''),
  shade_name varchar(200) CHECK (shade_name IS NULL OR btrim(shade_name) <> ''),
  net_quantity_value varchar(20),
  net_quantity_unit text,
  waterproof boolean,
  formula_complete boolean NOT NULL DEFAULT false,
  claim_kinds text[] NOT NULL DEFAULT '{}',
  price_kopecks integer CHECK (price_kopecks BETWEEN 1 AND 100000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wtm_private_product_snapshot_revision_fk
    FOREIGN KEY (observation_id, revision_id)
    REFERENCES wtm_product_observation_inci_revisions(observation_id, id) ON DELETE CASCADE,
  CONSTRAINT wtm_private_product_snapshot_quantity_valid CHECK (
    (net_quantity_value IS NULL AND net_quantity_unit IS NULL)
    OR (net_quantity_value IS NOT NULL AND net_quantity_unit IS NOT NULL
      AND net_quantity_value ~ '^[0-9]{1,8}(\.[0-9]{1,4})?$'
      AND net_quantity_value::numeric > 0
      AND net_quantity_unit IN ('MILLILITER', 'GRAM'))
  ),
  CONSTRAINT wtm_private_product_snapshot_claims_valid CHECK (
    cardinality(claim_kinds) <= 7
    AND array_position(claim_kinds, NULL) IS NULL
    AND claim_kinds <@ ARRAY['VOLUME','LENGTH','SEPARATION','NATURAL_LOOK','WATERPROOF','EASY_REMOVAL','OTHER']::text[]
  ),
  CONSTRAINT wtm_private_product_snapshot_number_unique UNIQUE (observation_id, snapshot_number),
  CONSTRAINT wtm_private_product_snapshot_fingerprint_unique UNIQUE (observation_id, fingerprint)
);

CREATE INDEX wtm_private_product_snapshot_recent_idx
  ON wtm_private_product_snapshots (observation_id, created_at DESC, id DESC);

CREATE FUNCTION wtm_guard_private_product_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_number integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Private product snapshots are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM wtm_product_observations WHERE id = OLD.observation_id) THEN
      RAISE EXCEPTION 'Private product snapshots may only be cascade-deleted with their observation' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  -- Serialize all writers, including callers outside the repository.
  PERFORM observation.id
  FROM wtm_product_observations AS observation
  JOIN wtm_media_collections AS collection ON collection.id = observation.media_collection_id
  WHERE observation.id = NEW.observation_id AND collection.deleted_at IS NULL
  FOR UPDATE OF observation, collection;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Private snapshot needs an active observation' USING ERRCODE = '23503';
  END IF;
  SELECT COALESCE(MAX(snapshot_number), 0) + 1 INTO expected_number
  FROM wtm_private_product_snapshots WHERE observation_id = NEW.observation_id;
  IF NEW.snapshot_number <> expected_number THEN
    RAISE EXCEPTION 'Private snapshots must be append-only and sequential' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wtm_private_product_snapshot_guard
BEFORE INSERT OR UPDATE OR DELETE ON wtm_private_product_snapshots
FOR EACH ROW EXECUTE FUNCTION wtm_guard_private_product_snapshot();

COMMENT ON TABLE wtm_private_product_snapshots IS
  'Private immutable packaging confirmations; claims and price are user-entered, never global catalog evidence. Ownership is inherited from the observation.';
