-- An OCR revision has a restrictive FK to its source media asset. Erase
-- observations (and their cascading revisions/snapshots) before collections.
-- Replacing the function preserves the existing trigger and old checksums.
CREATE OR REPLACE FUNCTION wtm_erase_deleted_guest_data()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    DELETE FROM wtm_product_observations WHERE guest_id = OLD.id;
    DELETE FROM wtm_media_collections WHERE guest_id = OLD.id;
  END IF;
  RETURN NEW;
END;
$$;
