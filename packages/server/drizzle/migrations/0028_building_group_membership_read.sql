-- Lets a building group record when its membership was read.
--
-- Since 0002, `psd_eoc_guard_group_source_identity_mutation` has frozen
-- building and others sources completely:
--
--   IF OLD."purpose" IN ('building', 'others')
--     AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)
--   THEN RAISE EXCEPTION ...
--
-- Not one column of such a row may change. That was right when a building
-- group was a node in the versioned roster graph, where the point was that a
-- published version could never be edited underneath a snapshot referencing it.
--
-- It is wrong now. A school's staff group is where notification recipients come
-- from, its membership is replaced wholesale each time the provider is read,
-- and `members_captured_at` is how anyone knows whether that read is recent.
-- Frozen, the column stays null forever: the sync writes the members and then
-- fails stamping the read, the whole publication rolls back, and no school ever
-- gets a roster. That is not theoretical — it is what the access-membership
-- sync does today for every group it is given.
--
-- Exactly one column is released, by comparing the two rows with that single
-- key removed. Identity, purpose, facility binding, provider locator, address,
-- display name, active flag and creation time all stay immutable.
--
-- This is a full redefinition of the 0005 body, not the 0002 one. 0005 added
-- the trigger-context assertion, `SET search_path = pg_catalog`, and the
-- access-group provider-locator guard. Rebuilding from 0002 would silently drop
-- all three — a first draft of this migration did exactly that, and
-- `roster-immutability.integration.test.ts` caught the lost access-group guard.
CREATE OR REPLACE FUNCTION public."psd_eoc_guard_group_source_identity_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	IF TG_RELID <> 'public.group_sources'::pg_catalog.regclass
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME <> 'group_sources'
		OR TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'UPDATE'
	THEN
		RAISE EXCEPTION 'Unexpected group-source identity trigger context'
			USING ERRCODE = '55000';
	END IF;

	IF OLD."purpose" IN ('building', 'others')
		AND (pg_catalog.to_jsonb(NEW) - 'members_captured_at')
			IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - 'members_captured_at')
	THEN
		RAISE EXCEPTION 'Group-source identity, provider locator, status, and presentation are immutable'
			USING ERRCODE = '55000';
	END IF;
	IF NEW."id" IS DISTINCT FROM OLD."id"
		OR NEW."kind" IS DISTINCT FROM OLD."kind"
		OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
		OR NEW."facility_id" IS DISTINCT FROM OLD."facility_id"
		OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
	THEN
		RAISE EXCEPTION 'Group-source identity, purpose, facility binding, and creation time are immutable'
			USING ERRCODE = '55000';
	END IF;
	IF OLD."purpose" = 'access'
		AND (
			NEW."google_group_id" IS DISTINCT FROM OLD."google_group_id"
			OR NEW."email" IS DISTINCT FROM OLD."email"
		)
	THEN
		RAISE EXCEPTION 'Access group provider locators are immutable; create a replacement identity'
			USING ERRCODE = '55000';
	END IF;

	RETURN NEW;
END;
$$;
