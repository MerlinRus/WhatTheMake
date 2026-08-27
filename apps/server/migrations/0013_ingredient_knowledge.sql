CREATE TABLE wtm_ingredient_knowledge_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version varchar(100) NOT NULL UNIQUE,
  based_on_snapshot_id uuid
    REFERENCES wtm_ingredient_knowledge_snapshots(id),
  status varchar(20) NOT NULL DEFAULT 'DRAFT',
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  retired_at timestamptz,
  CONSTRAINT wtm_ingredient_knowledge_version_valid CHECK (
    version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
  ),
  CONSTRAINT wtm_ingredient_knowledge_base_valid CHECK (
    based_on_snapshot_id IS DISTINCT FROM id
  ),
  CONSTRAINT wtm_ingredient_knowledge_status_valid CHECK (
    status IN ('DRAFT', 'PUBLISHED', 'RETIRED')
  ),
  CONSTRAINT wtm_ingredient_knowledge_state_valid CHECK (
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

CREATE UNIQUE INDEX wtm_ingredient_knowledge_one_published_idx
  ON wtm_ingredient_knowledge_snapshots ((status))
  WHERE status = 'PUBLISHED';

CREATE TABLE wtm_ingredient_function_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL
    REFERENCES wtm_ingredient_knowledge_snapshots(id) ON DELETE CASCADE,
  ingredient_id uuid NOT NULL REFERENCES wtm_inci_ingredients(id),
  function_code varchar(64) NOT NULL,
  jurisdiction varchar(32) NOT NULL,
  confidence varchar(10) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wtm_ingredient_function_facts_code_valid CHECK (
    function_code ~ '^[A-Z][A-Z0-9_]{1,63}$'
  ),
  CONSTRAINT wtm_ingredient_function_facts_jurisdiction_valid CHECK (
    jurisdiction ~ '^[A-Z][A-Z0-9_-]{1,31}$'
  ),
  CONSTRAINT wtm_ingredient_function_facts_confidence_valid CHECK (
    confidence IN ('LOW', 'MEDIUM', 'HIGH')
  ),
  CONSTRAINT wtm_ingredient_function_facts_identity_unique
    UNIQUE (snapshot_id, ingredient_id, function_code, jurisdiction),
  CONSTRAINT wtm_ingredient_function_facts_snapshot_id_unique
    UNIQUE (snapshot_id, id)
);

CREATE TABLE wtm_ingredient_fact_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL
    REFERENCES wtm_ingredient_knowledge_snapshots(id) ON DELETE CASCADE,
  evidence_type varchar(40) NOT NULL,
  source_url varchar(2048) NOT NULL,
  checked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wtm_ingredient_fact_evidence_type_valid CHECK (
    evidence_type IN (
      'REGULATION',
      'REGULATORY_ASSESSMENT',
      'OFFICIAL_DATABASE',
      'SCIENTIFIC_PUBLICATION',
      'MANUFACTURER_DOCUMENT'
    )
  ),
  CONSTRAINT wtm_ingredient_fact_evidence_url_valid CHECK (
    source_url ~ '^https?://[^/[:space:]@?#]+(?::[0-9]{1,5})?(?:[/?#][^[:space:]]*)?$'
  ),
  CONSTRAINT wtm_ingredient_fact_evidence_snapshot_id_unique
    UNIQUE (snapshot_id, id)
);

CREATE TABLE wtm_ingredient_fact_evidence_links (
  snapshot_id uuid NOT NULL,
  fact_id uuid NOT NULL,
  evidence_id uuid NOT NULL,
  stance varchar(20) NOT NULL,
  PRIMARY KEY (fact_id, evidence_id),
  CONSTRAINT wtm_ingredient_fact_evidence_links_stance_valid CHECK (
    stance IN ('SUPPORTS', 'CONTRADICTS')
  ),
  CONSTRAINT wtm_ingredient_fact_evidence_links_fact_fk
    FOREIGN KEY (snapshot_id, fact_id)
    REFERENCES wtm_ingredient_function_facts(snapshot_id, id)
    ON DELETE CASCADE,
  CONSTRAINT wtm_ingredient_fact_evidence_links_evidence_fk
    FOREIGN KEY (snapshot_id, evidence_id)
    REFERENCES wtm_ingredient_fact_evidence(snapshot_id, id)
    ON DELETE CASCADE
);

CREATE INDEX wtm_ingredient_function_facts_lookup_idx
  ON wtm_ingredient_function_facts (
    snapshot_id,
    ingredient_id,
    jurisdiction,
    function_code
  );

CREATE FUNCTION wtm_validate_ingredient_knowledge_snapshot_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  base_status text;
BEGIN
  IF NEW.based_on_snapshot_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT status INTO base_status
  FROM wtm_ingredient_knowledge_snapshots
  WHERE id = NEW.based_on_snapshot_id;

  IF base_status IS NULL THEN
    RAISE EXCEPTION 'Ingredient knowledge base version does not exist'
      USING ERRCODE = '23503';
  END IF;
  IF base_status NOT IN ('PUBLISHED', 'RETIRED') THEN
    RAISE EXCEPTION 'Ingredient knowledge base version must be immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wtm_ingredient_knowledge_snapshots_insert_guard
BEFORE INSERT ON wtm_ingredient_knowledge_snapshots
FOR EACH ROW EXECUTE FUNCTION wtm_validate_ingredient_knowledge_snapshot_insert();

CREATE FUNCTION wtm_require_draft_ingredient_knowledge_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  snapshot_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT status INTO snapshot_status
    FROM wtm_ingredient_knowledge_snapshots
    WHERE id = OLD.snapshot_id;
    IF snapshot_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'Published ingredient knowledge is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    SELECT status INTO snapshot_status
    FROM wtm_ingredient_knowledge_snapshots
    WHERE id = NEW.snapshot_id;
    IF snapshot_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'Published ingredient knowledge is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wtm_ingredient_function_facts_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON wtm_ingredient_function_facts
FOR EACH ROW EXECUTE FUNCTION wtm_require_draft_ingredient_knowledge_snapshot();

CREATE TRIGGER wtm_ingredient_fact_evidence_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON wtm_ingredient_fact_evidence
FOR EACH ROW EXECUTE FUNCTION wtm_require_draft_ingredient_knowledge_snapshot();

CREATE TRIGGER wtm_ingredient_fact_evidence_links_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON wtm_ingredient_fact_evidence_links
FOR EACH ROW EXECUTE FUNCTION wtm_require_draft_ingredient_knowledge_snapshot();

CREATE FUNCTION wtm_guard_ingredient_knowledge_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Published ingredient knowledge is immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.based_on_snapshot_id IS DISTINCT FROM OLD.based_on_snapshot_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Ingredient knowledge identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'DRAFT' THEN
    IF NEW.status = 'DRAFT' THEN
      RETURN NEW;
    END IF;
    IF NEW.status <> 'PUBLISHED' THEN
      RAISE EXCEPTION 'Invalid ingredient knowledge transition'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM wtm_ingredient_function_facts
      WHERE snapshot_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'Ingredient knowledge cannot publish without facts'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM wtm_ingredient_function_facts AS fact
      WHERE fact.snapshot_id = NEW.id
        AND NOT EXISTS (
          SELECT 1
          FROM wtm_ingredient_fact_evidence_links AS link
          WHERE link.snapshot_id = fact.snapshot_id
            AND link.fact_id = fact.id
            AND link.stance = 'SUPPORTS'
        )
    ) THEN
      RAISE EXCEPTION 'Published ingredient facts require supporting evidence'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM wtm_ingredient_fact_evidence
      WHERE snapshot_id = NEW.id
        AND checked_at > NEW.published_at
    ) THEN
      RAISE EXCEPTION 'Evidence cannot be checked after knowledge publication'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'PUBLISHED' THEN
    IF
      NEW.status <> 'RETIRED'
      OR NEW.published_at IS DISTINCT FROM OLD.published_at
    THEN
      RAISE EXCEPTION 'Published ingredient knowledge is immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Retired ingredient knowledge is immutable'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER wtm_ingredient_knowledge_snapshots_guard
BEFORE UPDATE OR DELETE ON wtm_ingredient_knowledge_snapshots
FOR EACH ROW EXECUTE FUNCTION wtm_guard_ingredient_knowledge_snapshot();

COMMENT ON TABLE wtm_ingredient_knowledge_snapshots IS
  'Versioned immutable ingredient-function knowledge; publication requires evidence.';
