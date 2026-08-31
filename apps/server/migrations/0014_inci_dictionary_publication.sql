ALTER TABLE wtm_inci_dictionary_snapshots
ADD COLUMN content_sha256 char(64);

ALTER TABLE wtm_inci_dictionary_snapshots
ADD CONSTRAINT wtm_inci_dictionary_content_sha_valid CHECK (
  content_sha256 IS NULL
  OR content_sha256 ~ '^[0-9a-f]{64}$'
);

CREATE UNIQUE INDEX wtm_inci_dictionary_content_sha_idx
  ON wtm_inci_dictionary_snapshots (content_sha256)
  WHERE content_sha256 IS NOT NULL;

COMMENT ON COLUMN wtm_inci_dictionary_snapshots.content_sha256 IS
  'Canonical checksum of the immutable dictionary artifact used by benchmark and runtime publication.';

CREATE OR REPLACE FUNCTION wtm_guard_inci_dictionary_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Published INCI dictionary snapshots are immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'DRAFT' THEN
    IF NEW.status NOT IN ('DRAFT', 'PUBLISHED') THEN
      RAISE EXCEPTION 'Invalid INCI dictionary snapshot transition'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.status = 'PUBLISHED' AND NEW.content_sha256 IS NULL THEN
      RAISE EXCEPTION 'Published INCI dictionary checksum is required'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'PUBLISHED' THEN
    IF
      NEW.status <> 'RETIRED'
      OR NEW.id IS DISTINCT FROM OLD.id
      OR NEW.version IS DISTINCT FROM OLD.version
      OR NEW.normalizer_version IS DISTINCT FROM OLD.normalizer_version
      OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.published_at IS DISTINCT FROM OLD.published_at
    THEN
      RAISE EXCEPTION 'Published INCI dictionary snapshots are immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Retired INCI dictionary snapshots are immutable'
    USING ERRCODE = '23514';
END;
$$;
