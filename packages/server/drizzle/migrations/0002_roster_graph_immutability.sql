CREATE OR REPLACE FUNCTION "psd_eoc_guard_roster_snapshot_child_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	parent_created_in_current_transaction boolean := false;
	row_already_exists boolean := false;
BEGIN
	-- A child is constructible only while its parent is still an uncommitted row
	-- from this transaction. After commit, the parent's xmin can no longer match.
	SELECT snapshot.xmin = pg_current_xact_id()::xid
	INTO parent_created_in_current_transaction
	FROM "roster_snapshots" AS snapshot
	WHERE snapshot."id" = NEW."roster_snapshot_id";

	IF parent_created_in_current_transaction IS TRUE THEN
		RETURN NEW;
	END IF;

	CASE TG_TABLE_NAME
		WHEN 'roster_snapshot_facilities' THEN
			SELECT EXISTS (
				SELECT 1
				FROM "roster_snapshot_facilities" AS existing
				WHERE existing."roster_snapshot_id" = NEW."roster_snapshot_id"
					AND existing."facility_id" = (to_jsonb(NEW) ->> 'facility_id')::uuid
			)
			INTO row_already_exists;
		WHEN 'roster_snapshot_sources' THEN
			SELECT EXISTS (
				SELECT 1
				FROM "roster_snapshot_sources" AS existing
				WHERE existing."roster_snapshot_id" = NEW."roster_snapshot_id"
					AND existing."group_source_id" = (to_jsonb(NEW) ->> 'group_source_id')::uuid
					AND existing."completion_kind"::text = to_jsonb(NEW) ->> 'completion_kind'
			)
			INTO row_already_exists;
		WHEN 'roster_recipients' THEN
			SELECT EXISTS (
				SELECT 1
				FROM "roster_recipients" AS existing
				WHERE existing."roster_snapshot_id" = NEW."roster_snapshot_id"
					AND existing."id" = (to_jsonb(NEW) ->> 'id')::uuid
			)
			INTO row_already_exists;
		WHEN 'roster_recipient_group_sources' THEN
			SELECT EXISTS (
				SELECT 1
				FROM "roster_recipient_group_sources" AS existing
				WHERE existing."roster_snapshot_id" = NEW."roster_snapshot_id"
					AND existing."recipient_id" = (to_jsonb(NEW) ->> 'recipient_id')::uuid
					AND existing."group_source_id" = (to_jsonb(NEW) ->> 'group_source_id')::uuid
			)
			INTO row_already_exists;
		WHEN 'roster_endpoints' THEN
			SELECT EXISTS (
				SELECT 1
				FROM "roster_endpoints" AS existing
				WHERE existing."roster_snapshot_id" = NEW."roster_snapshot_id"
					AND existing."id" = (to_jsonb(NEW) ->> 'id')::uuid
			)
			INTO row_already_exists;
		ELSE
			RAISE EXCEPTION 'Unexpected roster snapshot child table %', TG_TABLE_NAME
				USING ERRCODE = '55000';
	END CASE;

	IF row_already_exists THEN
		-- Preserve conflict-safe, idempotent retries. A conflicting DO UPDATE still
		-- reaches the table's immutable UPDATE trigger and is rejected.
		RETURN NEW;
	END IF;

	RAISE EXCEPTION 'Published roster snapshot % cannot accept new % rows', NEW."roster_snapshot_id", TG_TABLE_NAME
		USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "psd_eoc_guard_roster_sync_child_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	parent_created_in_current_transaction boolean := false;
	row_already_exists boolean := false;
BEGIN
	-- Sync evidence follows the same atomic parent-and-children construction
	-- protocol as roster snapshots.
	SELECT sync_result.xmin = pg_current_xact_id()::xid
	INTO parent_created_in_current_transaction
	FROM "roster_sync_results" AS sync_result
	WHERE sync_result."id" = NEW."sync_result_id";

	IF parent_created_in_current_transaction IS TRUE THEN
		RETURN NEW;
	END IF;

	CASE TG_TABLE_NAME
		WHEN 'roster_sync_result_sources' THEN
			SELECT EXISTS (
				SELECT 1
				FROM "roster_sync_result_sources" AS existing
				WHERE existing."sync_result_id" = NEW."sync_result_id"
					AND existing."population"::text = to_jsonb(NEW) ->> 'population'
					AND existing."group_source_id" = (to_jsonb(NEW) ->> 'group_source_id')::uuid
					AND existing."group_source_kind"::text = to_jsonb(NEW) ->> 'group_source_kind'
					AND existing."group_purpose"::text = to_jsonb(NEW) ->> 'group_purpose'
					AND existing."set_kind"::text = to_jsonb(NEW) ->> 'set_kind'
			)
			INTO row_already_exists;
		WHEN 'roster_sync_group_failures' THEN
			SELECT EXISTS (
				SELECT 1
				FROM "roster_sync_group_failures" AS existing
				WHERE existing."id" = (to_jsonb(NEW) ->> 'id')::uuid
			)
			INTO row_already_exists;
		ELSE
			RAISE EXCEPTION 'Unexpected roster sync child table %', TG_TABLE_NAME
				USING ERRCODE = '55000';
	END CASE;

	IF row_already_exists THEN
		-- Existing primary keys may be retried with ON CONFLICT DO NOTHING.
		RETURN NEW;
	END IF;

	RAISE EXCEPTION 'Published roster sync result % cannot accept new % rows', NEW."sync_result_id", TG_TABLE_NAME
		USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "psd_eoc_guard_roster_configuration_child_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	parent_created_in_current_transaction boolean := false;
	row_already_exists boolean := false;
BEGIN
	SELECT configuration.xmin = pg_current_xact_id()::xid
	INTO parent_created_in_current_transaction
	FROM "roster_source_configurations" AS configuration
	WHERE configuration."id" = NEW."configuration_id"
		AND configuration."version" = NEW."configuration_version";

	IF parent_created_in_current_transaction IS TRUE THEN
		RETURN NEW;
	END IF;

	CASE TG_TABLE_NAME
		WHEN 'roster_source_configuration_facilities' THEN
			SELECT EXISTS (
				SELECT 1
				FROM "roster_source_configuration_facilities" AS existing
				WHERE existing."configuration_id" = NEW."configuration_id"
					AND existing."configuration_version" = NEW."configuration_version"
					AND existing."facility_id" = (to_jsonb(NEW) ->> 'facility_id')::uuid
			)
			INTO row_already_exists;
		WHEN 'roster_source_configuration_groups' THEN
			SELECT EXISTS (
				SELECT 1
				FROM "roster_source_configuration_groups" AS existing
				WHERE existing."configuration_id" = NEW."configuration_id"
					AND existing."configuration_version" = NEW."configuration_version"
					AND existing."group_source_id" = (to_jsonb(NEW) ->> 'group_source_id')::uuid
			)
			INTO row_already_exists;
		ELSE
			RAISE EXCEPTION 'Unexpected roster configuration child table %', TG_TABLE_NAME
				USING ERRCODE = '55000';
	END CASE;

	IF row_already_exists THEN
		RETURN NEW;
	END IF;

	RAISE EXCEPTION 'Published roster source configuration % version % cannot accept new % rows', NEW."configuration_id", NEW."configuration_version", TG_TABLE_NAME
		USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "psd_eoc_guard_group_source_identity_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."id" IS DISTINCT FROM OLD."id"
		OR NEW."kind" IS DISTINCT FROM OLD."kind"
		OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
		OR NEW."facility_id" IS DISTINCT FROM OLD."facility_id"
		OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
	THEN
		RAISE EXCEPTION 'Group-source identity, purpose, facility binding, and creation time are immutable'
			USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "roster_source_configurations_immutable_guard"
BEFORE UPDATE ON "roster_source_configurations"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_reject_immutable_mutation"();--> statement-breakpoint
CREATE TRIGGER "roster_source_configuration_facilities_immutable_guard"
BEFORE UPDATE ON "roster_source_configuration_facilities"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_reject_immutable_mutation"();--> statement-breakpoint
CREATE TRIGGER "roster_source_configuration_groups_immutable_guard"
BEFORE UPDATE ON "roster_source_configuration_groups"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_reject_immutable_mutation"();--> statement-breakpoint
CREATE TRIGGER "group_sources_identity_guard"
BEFORE UPDATE ON "group_sources"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_guard_group_source_identity_mutation"();--> statement-breakpoint

CREATE TRIGGER "roster_source_configuration_facilities_construction_guard"
BEFORE INSERT ON "roster_source_configuration_facilities"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_guard_roster_configuration_child_insert"();--> statement-breakpoint
CREATE TRIGGER "roster_source_configuration_groups_construction_guard"
BEFORE INSERT ON "roster_source_configuration_groups"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_guard_roster_configuration_child_insert"();--> statement-breakpoint

CREATE TRIGGER "roster_snapshot_facilities_immutable_guard"
BEFORE UPDATE ON "roster_snapshot_facilities"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_reject_immutable_mutation"();--> statement-breakpoint
CREATE TRIGGER "roster_snapshot_sources_immutable_guard"
BEFORE UPDATE ON "roster_snapshot_sources"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_reject_immutable_mutation"();--> statement-breakpoint
CREATE TRIGGER "roster_recipient_group_sources_immutable_guard"
BEFORE UPDATE ON "roster_recipient_group_sources"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_reject_immutable_mutation"();--> statement-breakpoint
CREATE TRIGGER "roster_sync_result_sources_immutable_guard"
BEFORE UPDATE ON "roster_sync_result_sources"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_reject_immutable_mutation"();--> statement-breakpoint
CREATE TRIGGER "roster_sync_group_failures_immutable_guard"
BEFORE UPDATE ON "roster_sync_group_failures"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_reject_immutable_mutation"();--> statement-breakpoint

CREATE TRIGGER "roster_snapshot_facilities_construction_guard"
BEFORE INSERT ON "roster_snapshot_facilities"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_guard_roster_snapshot_child_insert"();--> statement-breakpoint
CREATE TRIGGER "roster_snapshot_sources_construction_guard"
BEFORE INSERT ON "roster_snapshot_sources"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_guard_roster_snapshot_child_insert"();--> statement-breakpoint
CREATE TRIGGER "roster_recipients_construction_guard"
BEFORE INSERT ON "roster_recipients"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_guard_roster_snapshot_child_insert"();--> statement-breakpoint
CREATE TRIGGER "roster_recipient_group_sources_construction_guard"
BEFORE INSERT ON "roster_recipient_group_sources"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_guard_roster_snapshot_child_insert"();--> statement-breakpoint
CREATE TRIGGER "roster_endpoints_construction_guard"
BEFORE INSERT ON "roster_endpoints"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_guard_roster_snapshot_child_insert"();--> statement-breakpoint
CREATE TRIGGER "roster_sync_result_sources_construction_guard"
BEFORE INSERT ON "roster_sync_result_sources"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_guard_roster_sync_child_insert"();--> statement-breakpoint
CREATE TRIGGER "roster_sync_group_failures_construction_guard"
BEFORE INSERT ON "roster_sync_group_failures"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_guard_roster_sync_child_insert"();
