CREATE TABLE wtm_mascara_preference_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES wtm_accounts(id) ON DELETE CASCADE,
  profile_version integer NOT NULL,
  schema_version smallint NOT NULL DEFAULT 1,
  mode text NOT NULL,
  goals text[] NOT NULL DEFAULT '{}',
  waterproof_preference text NOT NULL,
  removal_preference text NOT NULL,
  sensitive_eyes boolean NOT NULL,
  contact_lenses boolean NOT NULL,
  avoided_ingredients text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wtm_mascara_preference_account_version_unique
    UNIQUE (account_id, profile_version),
  CONSTRAINT wtm_mascara_preference_version_positive
    CHECK (profile_version > 0),
  CONSTRAINT wtm_mascara_preference_schema_version_valid
    CHECK (schema_version = 1),
  CONSTRAINT wtm_mascara_preference_mode_valid
    CHECK (mode IN ('PERSONALIZED', 'UNKNOWN_GOALS')),
  CONSTRAINT wtm_mascara_preference_goals_valid CHECK (
    goals <@ ARRAY['VOLUME', 'LENGTH', 'SEPARATION', 'NATURAL_LOOK']::text[]
    AND cardinality(goals) <= 4
    AND (
      (mode = 'PERSONALIZED' AND cardinality(goals) >= 1)
      OR (mode = 'UNKNOWN_GOALS' AND cardinality(goals) = 0)
    )
  ),
  CONSTRAINT wtm_mascara_preference_waterproof_valid CHECK (
    waterproof_preference IN ('REQUIRED', 'AVOID', 'NO_PREFERENCE')
  ),
  CONSTRAINT wtm_mascara_preference_removal_valid CHECK (
    removal_preference IN ('EASY_REQUIRED', 'NO_PREFERENCE')
  ),
  CONSTRAINT wtm_mascara_preference_avoided_ingredients_limit
    CHECK (cardinality(avoided_ingredients) <= 50)
);

CREATE INDEX wtm_mascara_preference_current_idx
  ON wtm_mascara_preference_versions (account_id, profile_version DESC);

COMMENT ON TABLE wtm_mascara_preference_versions IS
  'Immutable versioned mascara preference profiles; analyses copy their snapshot.';
