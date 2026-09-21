CREATE TABLE wtm_customer_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES wtm_accounts(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES wtm_product_variants(id),
  current_revision_number integer NOT NULL CHECK (current_revision_number >= 1),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','DELETED')),
  duplicate_text boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (account_id, variant_id)
);

CREATE TABLE wtm_customer_review_revisions (
  review_id uuid NOT NULL REFERENCES wtm_customer_reviews(id) ON DELETE CASCADE,
  revision_number integer NOT NULL CHECK (revision_number >= 1),
  stars smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 20 AND 4000),
  normalized_sha256 char(64) NOT NULL CHECK (normalized_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (review_id, revision_number)
);
ALTER TABLE wtm_customer_reviews ADD CONSTRAINT wtm_customer_review_current_revision_fk
  FOREIGN KEY (id, current_revision_number)
  REFERENCES wtm_customer_review_revisions(review_id, revision_number)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE wtm_customer_review_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  review_id uuid NOT NULL REFERENCES wtm_customer_reviews(id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  action text NOT NULL CHECK (action IN ('SUBMITTED','EDITED','MODERATED','DELETED')),
  actor_label varchar(200) NOT NULL CHECK (btrim(actor_label) <> ''),
  reason varchar(1000) NOT NULL CHECK (btrim(reason) <> ''),
  previous_status text CHECK (previous_status IN ('PENDING','APPROVED','REJECTED','DELETED')),
  next_status text NOT NULL CHECK (next_status IN ('PENDING','APPROVED','REJECTED','DELETED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (review_id, revision_number) REFERENCES wtm_customer_review_revisions(review_id, revision_number)
);

CREATE INDEX wtm_customer_review_summary_idx ON wtm_customer_reviews (variant_id, status);
CREATE INDEX wtm_customer_review_hash_idx ON wtm_customer_review_revisions (normalized_sha256);
CREATE INDEX wtm_customer_review_audit_idx ON wtm_customer_review_audit (review_id, id);

CREATE FUNCTION wtm_guard_customer_review_history()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM wtm_customer_reviews WHERE id = OLD.review_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Customer review history is append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER wtm_customer_review_revision_immutable BEFORE UPDATE OR DELETE ON wtm_customer_review_revisions
  FOR EACH ROW EXECUTE FUNCTION wtm_guard_customer_review_history();
CREATE TRIGGER wtm_customer_review_audit_immutable BEFORE UPDATE OR DELETE ON wtm_customer_review_audit
  FOR EACH ROW EXECUTE FUNCTION wtm_guard_customer_review_history();

COMMENT ON TABLE wtm_customer_reviews IS
  'Account-authored exact-variant reviews; purchase and email are not verified. Only latest approved revision contributes, with low source quality.';
