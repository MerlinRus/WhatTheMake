CREATE TABLE wtm_inci_ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wtm_inci_dictionary_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version varchar(100) NOT NULL UNIQUE,
  normalizer_version varchar(100) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'DRAFT',
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  retired_at timestamptz,
  CONSTRAINT wtm_inci_dictionary_snapshots_version_valid CHECK (
    version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
  ),
  CONSTRAINT wtm_inci_dictionary_snapshots_normalizer_valid CHECK (
    normalizer_version = 'inci-lookup-v1'
  ),
  CONSTRAINT wtm_inci_dictionary_snapshots_status_valid CHECK (
    status IN ('DRAFT', 'PUBLISHED', 'RETIRED')
  ),
  CONSTRAINT wtm_inci_dictionary_snapshots_state_valid CHECK (
    (
      status = 'DRAFT'
      AND published_at IS NULL
      AND retired_at IS NULL
    )
    OR (
      status = 'PUBLISHED'
      AND published_at IS NOT NULL
      AND retired_at IS NULL
    )
    OR (
      status = 'RETIRED'
      AND published_at IS NOT NULL
      AND retired_at IS NOT NULL
      AND retired_at >= published_at
    )
  )
);

CREATE UNIQUE INDEX wtm_inci_dictionary_one_published_idx
  ON wtm_inci_dictionary_snapshots ((status))
  WHERE status = 'PUBLISHED';

CREATE TABLE wtm_inci_dictionary_entries (
  snapshot_id uuid NOT NULL
    REFERENCES wtm_inci_dictionary_snapshots(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES wtm_inci_ingredients(id),
  canonical_name varchar(300) NOT NULL,
  canonical_lookup_key varchar(300) NOT NULL,
  PRIMARY KEY (snapshot_id, ingredient_id),
  CONSTRAINT wtm_inci_dictionary_entries_name_valid CHECK (
    length(btrim(canonical_name)) BETWEEN 1 AND 300
  ),
  CONSTRAINT wtm_inci_dictionary_entries_lookup_valid CHECK (
    length(canonical_lookup_key) BETWEEN 1 AND 300
    AND canonical_lookup_key = btrim(canonical_lookup_key)
    AND canonical_lookup_key = lower(canonical_lookup_key)
    AND canonical_lookup_key !~ '[[:space:]]{2,}'
  ),
  CONSTRAINT wtm_inci_dictionary_entries_canonical_unique
    UNIQUE (snapshot_id, canonical_lookup_key)
);

CREATE TABLE wtm_inci_dictionary_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL,
  ingredient_id uuid NOT NULL,
  alias_text varchar(300) NOT NULL,
  lookup_key varchar(300) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wtm_inci_dictionary_aliases_entry_fk
    FOREIGN KEY (snapshot_id, ingredient_id)
    REFERENCES wtm_inci_dictionary_entries(snapshot_id, ingredient_id)
    ON DELETE CASCADE,
  CONSTRAINT wtm_inci_dictionary_aliases_text_valid CHECK (
    length(btrim(alias_text)) BETWEEN 1 AND 300
  ),
  CONSTRAINT wtm_inci_dictionary_aliases_lookup_valid CHECK (
    length(lookup_key) BETWEEN 1 AND 300
    AND lookup_key = btrim(lookup_key)
    AND lookup_key = lower(lookup_key)
    AND lookup_key !~ '[[:space:]]{2,}'
  ),
  CONSTRAINT wtm_inci_dictionary_aliases_mapping_unique
    UNIQUE (snapshot_id, lookup_key, ingredient_id)
);

CREATE INDEX wtm_inci_dictionary_aliases_lookup_idx
  ON wtm_inci_dictionary_aliases (snapshot_id, lookup_key, ingredient_id);

CREATE FUNCTION wtm_require_draft_inci_dictionary_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  snapshot_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT status INTO snapshot_status
    FROM wtm_inci_dictionary_snapshots
    WHERE id = OLD.snapshot_id;
    IF snapshot_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'Published INCI dictionary snapshots are immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    SELECT status INTO snapshot_status
    FROM wtm_inci_dictionary_snapshots
    WHERE id = NEW.snapshot_id;
    IF snapshot_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'Published INCI dictionary snapshots are immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wtm_inci_dictionary_entries_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON wtm_inci_dictionary_entries
FOR EACH ROW EXECUTE FUNCTION wtm_require_draft_inci_dictionary_snapshot();

CREATE TRIGGER wtm_inci_dictionary_aliases_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON wtm_inci_dictionary_aliases
FOR EACH ROW EXECUTE FUNCTION wtm_require_draft_inci_dictionary_snapshot();

CREATE FUNCTION wtm_guard_inci_dictionary_snapshot()
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
    RETURN NEW;
  END IF;

  IF OLD.status = 'PUBLISHED' THEN
    IF
      NEW.status <> 'RETIRED'
      OR NEW.id IS DISTINCT FROM OLD.id
      OR NEW.version IS DISTINCT FROM OLD.version
      OR NEW.normalizer_version IS DISTINCT FROM OLD.normalizer_version
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

CREATE TRIGGER wtm_inci_dictionary_snapshots_guard
BEFORE UPDATE OR DELETE ON wtm_inci_dictionary_snapshots
FOR EACH ROW EXECUTE FUNCTION wtm_guard_inci_dictionary_snapshot();

COMMENT ON TABLE wtm_inci_dictionary_snapshots IS
  'Immutable versioned INCI name and alias dictionaries; ingredient facts live in the knowledge model.';
