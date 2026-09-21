-- Physical blob cleanup must survive cascading deletion of its metadata.
CREATE FUNCTION wtm_require_active_media_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_kind = 'ACCOUNT' THEN
    PERFORM id FROM wtm_accounts WHERE id = NEW.account_id AND status = 'ACTIVE' FOR SHARE;
  ELSE
    PERFORM id FROM wtm_guests
    WHERE id = NEW.guest_id AND deleted_at IS NULL AND claimed_by_account_id IS NULL FOR SHARE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Private data requires an active owner' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wtm_active_private_owner
BEFORE INSERT OR UPDATE OF owner_kind, guest_id, account_id ON wtm_media_collections
FOR EACH ROW EXECUTE FUNCTION wtm_require_active_media_owner();

CREATE FUNCTION wtm_enqueue_erased_media()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO wtm_media_recovery_jobs(operation_kind, resource_id)
  VALUES ('DELETE_ASSET', OLD.id)
  ON CONFLICT (operation_kind, resource_id) DO NOTHING;
  RETURN OLD;
END;
$$;

CREATE TRIGGER wtm_erased_media_cleanup
AFTER DELETE ON wtm_media_assets
FOR EACH ROW EXECUTE FUNCTION wtm_enqueue_erased_media();

CREATE FUNCTION wtm_erase_deleted_guest_data()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    DELETE FROM wtm_media_collections WHERE guest_id = OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wtm_deleted_guest_erasure
AFTER UPDATE OF deleted_at ON wtm_guests
FOR EACH ROW EXECUTE FUNCTION wtm_erase_deleted_guest_data();

-- Repair previously revoked guests whose private payloads were retained.
DELETE FROM wtm_media_collections
WHERE guest_id IN (SELECT id FROM wtm_guests WHERE deleted_at IS NOT NULL);
