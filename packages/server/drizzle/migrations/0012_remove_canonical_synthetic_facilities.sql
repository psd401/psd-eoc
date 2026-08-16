SET LOCAL TIME ZONE 'UTC';
--> statement-breakpoint
LOCK TABLE
	public."facilities",
	public."neighborhood_versions",
	public."neighborhood_facilities",
	public."group_sources",
	public."audience_configurations",
	public."audience_targets",
	public."roster_source_configurations",
	public."roster_source_configuration_facilities",
	public."roster_source_configuration_groups",
	public."roster_snapshots",
	public."roster_snapshot_facilities",
	public."roster_snapshot_sources",
	public."roster_sync_results",
	public."roster_sync_result_sources",
	public."roster_sync_group_failures",
	public."roster_recipients",
	public."roster_recipient_group_sources",
	public."roster_endpoints",
	public."access_membership_snapshot_groups",
	public."access_membership_member_groups",
	public."access_membership_member_facilities",
	public."user_facility_scopes",
	public."agent_api_key_facilities",
	public."activation_previews",
	public."prepared_activations",
	public."prepared_activation_consumptions",
	public."lifecycle_consequence_previews",
	public."events",
	public."event_transitions",
	public."journal_entries",
	public."notification_intents",
	public."notification_intent_channels",
	public."fanout_intent_authorizations",
	public."outbox",
	public."dispatch_batches",
	public."channel_attempts",
	public."delivery_evidence",
	public."delivery_test_canary_eligibility_facts",
	public."delivery_test_target_set_versions",
	public."delivery_test_target_endpoints",
	public."delivery_test_runs",
	public."delivery_test_reports",
	public."endpoint_status_records",
	public."sms_opt_out_records",
	public."media_upload_intents",
	public."media_records",
	public."security_audit_entries",
	public."idempotency_records"
IN ACCESS EXCLUSIVE MODE NOWAIT;
--> statement-breakpoint
CREATE TABLE "security_audit_facility_anchors" (
	"facility_id" uuid PRIMARY KEY NOT NULL
);
--> statement-breakpoint
INSERT INTO public."security_audit_facility_anchors" ("facility_id")
SELECT "id" FROM public."facilities"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE public."security_audit_entries"
DROP CONSTRAINT "security_audit_entries_facility_id_facilities_id_fk";
--> statement-breakpoint
ALTER TABLE public."security_audit_entries"
ADD CONSTRAINT "security_audit_entries_facility_id_security_audit_facility_anchors_facility_id_fk"
FOREIGN KEY ("facility_id")
REFERENCES public."security_audit_facility_anchors"("facility_id")
ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public."psd_eoc_anchor_facility_insert"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
	IF TG_RELID <> 'public.facilities'::pg_catalog.regclass
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME <> 'facilities'
		OR TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'INSERT'
	THEN
		RAISE EXCEPTION 'Unexpected facility audit-anchor trigger context'
			USING ERRCODE = '55000';
	END IF;
	INSERT INTO public."security_audit_facility_anchors" ("facility_id")
	VALUES (NEW."id")
	ON CONFLICT ("facility_id") DO NOTHING;
	IF NOT FOUND AND NOT EXISTS (
		SELECT 1 FROM public."facilities" WHERE "id" = NEW."id"
	) THEN
		RAISE EXCEPTION 'A retained facility identity cannot be reused after operational deletion'
			USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "facilities_audit_anchor_insert"
BEFORE INSERT ON public."facilities"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_anchor_facility_insert"();
--> statement-breakpoint
CREATE TRIGGER "security_audit_facility_anchors_immutable_guard"
BEFORE UPDATE OR DELETE ON public."security_audit_facility_anchors"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_anchor_facility_insert"()
FROM PUBLIC, "psd_eoc_app";
--> statement-breakpoint
REVOKE ALL ON TABLE public."security_audit_facility_anchors"
FROM PUBLIC, "psd_eoc_app";
--> statement-breakpoint
GRANT SELECT ON TABLE public."security_audit_facility_anchors"
TO "psd_eoc_app";
--> statement-breakpoint
DO $$
DECLARE
	synthetic_facility_ids constant uuid[] := ARRAY[
		'00000000-0000-4000-8000-000000000001'::uuid,
		'00000000-0000-4000-8000-000000000002'::uuid
	];
	synthetic_group_ids constant uuid[] := ARRAY[
		'00000000-0000-4000-8000-000000000030'::uuid,
		'00000000-0000-4000-8000-000000000031'::uuid,
		'00000000-0000-4000-8000-000000000032'::uuid
	];
	synthetic_audience_ids constant uuid[] := ARRAY[
		'00000000-0000-4000-8000-000000000020'::uuid,
		'00000000-0000-4000-8000-000000000021'::uuid
	];
	synthetic_recipient_ids constant uuid[] := ARRAY[
		'00000000-0000-4000-8000-000000000050'::uuid,
		'00000000-0000-4000-8000-000000000051'::uuid,
		'00000000-0000-4000-8000-000000000052'::uuid,
		'00000000-0000-4000-8000-000000000053'::uuid
	];
	synthetic_endpoint_ids constant uuid[] := ARRAY[
		'00000000-0000-4000-8000-000000000060'::uuid,
		'00000000-0000-4000-8000-000000000061'::uuid,
		'00000000-0000-4000-8000-000000000062'::uuid,
		'00000000-0000-4000-8000-000000000063'::uuid,
		'00000000-0000-4000-8000-000000000064'::uuid,
		'00000000-0000-4000-8000-000000000065'::uuid,
		'00000000-0000-4000-8000-000000000066'::uuid,
		'00000000-0000-4000-8000-000000000067'::uuid,
		'00000000-0000-4000-8000-000000000068'::uuid,
		'00000000-0000-4000-8000-000000000069'::uuid,
		'00000000-0000-4000-8000-000000000070'::uuid,
		'00000000-0000-4000-8000-000000000071'::uuid
	];
	affected_tables constant text[] := ARRAY[
		'roster_endpoints', 'roster_recipient_group_sources',
		'roster_recipients', 'roster_snapshot_sources',
		'roster_snapshot_facilities', 'roster_snapshots',
		'roster_source_configuration_groups',
		'roster_source_configuration_facilities',
		'roster_source_configurations', 'audience_targets',
		'audience_configurations', 'neighborhood_facilities',
		'neighborhood_versions', 'group_sources', 'facilities'
	];
	candidate_facility_count integer;
	graph_row_count integer;
	dependency_count integer;
	guard_count integer;
	deleted_count integer;
	deleted_total integer := 0;
	table_name text;
	graph_fingerprint text;
	graph_variant text;
	expected_graph_row_count integer;
	expected_dependency_count integer;
	expected_graph_fingerprint text;
	audit_reference_count integer;
	real_facility_count integer;
	real_neighborhood_count integer;
	audit_digest_before text;
	audit_anchor_digest_before text;
	idempotency_digest_before text;
	real_facilities_digest_before text;
	real_neighborhoods_digest_before text;
	audit_head_before jsonb;
BEGIN
	SELECT count(*)::integer INTO candidate_facility_count
	FROM public."facilities"
	WHERE "id" = ANY(synthetic_facility_ids)
		OR "code" IN ('SYN-NORTH', 'SYN-SOUTH');

	IF candidate_facility_count = 0 THEN
		SELECT
			(SELECT count(*) FROM public."neighborhood_versions" WHERE "id" = '00000000-0000-4000-8000-000000000010'::uuid OR "name" = 'Synthetic Twin Campuses') +
			(SELECT count(*) FROM public."neighborhood_facilities" WHERE "neighborhood_id" = '00000000-0000-4000-8000-000000000010'::uuid OR "facility_id" = ANY(synthetic_facility_ids)) +
			(SELECT count(*) FROM public."group_sources" WHERE "id" = ANY(synthetic_group_ids) OR "fixture_key" IN ('synthetic-north-staff', 'synthetic-south-staff', 'synthetic-district-support-staff')) +
			(SELECT count(*) FROM public."audience_configurations" WHERE "id" = ANY(synthetic_audience_ids)) +
			(SELECT count(*) FROM public."audience_targets" WHERE "audience_config_id" = ANY(synthetic_audience_ids) OR "target_facility_id" = ANY(synthetic_facility_ids) OR "neighborhood_id" = '00000000-0000-4000-8000-000000000010'::uuid OR "group_source_id" = ANY(synthetic_group_ids)) +
			(SELECT count(*) FROM public."roster_source_configurations" WHERE "id" = '00000000-0000-4000-8000-000000000040'::uuid) +
			(SELECT count(*) FROM public."roster_source_configuration_facilities" WHERE "configuration_id" = '00000000-0000-4000-8000-000000000040'::uuid OR "facility_id" = ANY(synthetic_facility_ids)) +
			(SELECT count(*) FROM public."roster_source_configuration_groups" WHERE "configuration_id" = '00000000-0000-4000-8000-000000000040'::uuid OR "group_source_id" = ANY(synthetic_group_ids)) +
			(SELECT count(*) FROM public."roster_snapshots" WHERE "id" = '00000000-0000-4000-8000-000000000041'::uuid) +
			(SELECT count(*) FROM public."roster_snapshot_facilities" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid OR "facility_id" = ANY(synthetic_facility_ids)) +
			(SELECT count(*) FROM public."roster_snapshot_sources" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid OR "group_source_id" = ANY(synthetic_group_ids)) +
			(SELECT count(*) FROM public."roster_recipients" WHERE "id" = ANY(synthetic_recipient_ids)) +
			(SELECT count(*) FROM public."roster_recipient_group_sources" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid OR "recipient_id" = ANY(synthetic_recipient_ids) OR "group_source_id" = ANY(synthetic_group_ids)) +
			(SELECT count(*) FROM public."roster_endpoints" WHERE "id" = ANY(synthetic_endpoint_ids) OR "recipient_id" = ANY(synthetic_recipient_ids) OR "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid OR "token" IN ('synthetic-unroutable:north-one', 'synthetic-unroutable:north-two', 'synthetic-unroutable:south-one', 'synthetic-unroutable:south-two') OR "email" IN ('north-one@example.invalid', 'north-two@example.invalid', 'south-one@example.invalid', 'south-two@example.invalid') OR "phone_number" IN ('+12025550101', '+12025550102', '+12025550103', '+12025550104'))
		INTO graph_row_count;
		IF graph_row_count <> 0 THEN
			RAISE EXCEPTION 'Canonical synthetic facility fixture is partial without its facilities'
				USING ERRCODE = '55000';
		END IF;
		RETURN;
	END IF;

	IF candidate_facility_count <> 2 OR EXISTS (
		(SELECT "id", "code", "name", "created_at"
		 FROM public."facilities"
		 WHERE "id" = ANY(synthetic_facility_ids)
		    OR "code" IN ('SYN-NORTH', 'SYN-SOUTH'))
		EXCEPT
		(VALUES
			('00000000-0000-4000-8000-000000000001'::uuid, 'SYN-NORTH'::varchar(32), 'Synthetic North Campus'::varchar(160), '2026-08-06 12:00:00+00'::timestamptz),
			('00000000-0000-4000-8000-000000000002'::uuid, 'SYN-SOUTH'::varchar(32), 'Synthetic South Campus'::varchar(160), '2026-08-06 12:00:00+00'::timestamptz)
		)
	) OR EXISTS (
		(VALUES
			('00000000-0000-4000-8000-000000000001'::uuid, 'SYN-NORTH'::varchar(32), 'Synthetic North Campus'::varchar(160), '2026-08-06 12:00:00+00'::timestamptz),
			('00000000-0000-4000-8000-000000000002'::uuid, 'SYN-SOUTH'::varchar(32), 'Synthetic South Campus'::varchar(160), '2026-08-06 12:00:00+00'::timestamptz)
		)
		EXCEPT
		(SELECT "id", "code", "name", "created_at"
		 FROM public."facilities"
		 WHERE "id" = ANY(synthetic_facility_ids)
		    OR "code" IN ('SYN-NORTH', 'SYN-SOUTH'))
	) THEN
		RAISE EXCEPTION 'Canonical synthetic facility identity fingerprints do not match the approved fixture'
			USING ERRCODE = '55000';
	END IF;

	IF EXISTS (
		SELECT 1 FROM public."facilities"
		WHERE "id" = '00000000-0000-4000-8000-000000000001'::uuid AND "active"
	) AND EXISTS (
		SELECT 1 FROM public."facilities"
		WHERE "id" = '00000000-0000-4000-8000-000000000002'::uuid AND "active"
	) THEN
		graph_variant := 'pristine-seed';
		expected_graph_row_count := 53;
		expected_dependency_count := 51;
		expected_graph_fingerprint := '71112b7cdf186435d6a2430d1a69d876';
	ELSIF EXISTS (
		SELECT 1 FROM public."facilities"
		WHERE "id" = '00000000-0000-4000-8000-000000000001'::uuid AND NOT "active"
	) AND EXISTS (
		SELECT 1 FROM public."facilities"
		WHERE "id" = '00000000-0000-4000-8000-000000000002'::uuid AND "active"
	) THEN
		graph_variant := 'reviewed-live';
		expected_graph_row_count := 57;
		expected_dependency_count := 55;
		expected_graph_fingerprint := 'eac73c9cbee04db4187c9b4c77b7922c';
	ELSE
		RAISE EXCEPTION 'Canonical synthetic facility active states do not match an approved purge shape'
			USING ERRCODE = '55000';
	END IF;

	SELECT
		(SELECT count(*) FROM public."facilities" WHERE "id" = ANY(synthetic_facility_ids)) +
		(SELECT count(*) FROM public."neighborhood_versions" WHERE "id" = '00000000-0000-4000-8000-000000000010'::uuid AND "version" = 1 AND "name" = 'Synthetic Twin Campuses') +
		(SELECT count(*) FROM public."neighborhood_facilities" WHERE "neighborhood_id" = '00000000-0000-4000-8000-000000000010'::uuid AND "neighborhood_version" = 1 AND "facility_id" = ANY(synthetic_facility_ids)) +
		(SELECT count(*) FROM public."group_sources" WHERE "id" = ANY(synthetic_group_ids) AND "kind" = 'synthetic' AND "google_group_id" IS NULL AND "email" IS NULL) +
		(SELECT count(*) FROM public."audience_configurations" WHERE "id" = ANY(synthetic_audience_ids) AND "facility_id" = ANY(synthetic_facility_ids) AND "version" = 1) +
		(SELECT count(*) FROM public."audience_targets" WHERE "audience_config_id" = ANY(synthetic_audience_ids) AND "audience_config_version" = 1) +
		(SELECT count(*) FROM public."roster_source_configurations" WHERE "id" = '00000000-0000-4000-8000-000000000040'::uuid AND "version" IN (1, 2) AND "population" = 'synthetic') +
		(SELECT count(*) FROM public."roster_source_configuration_facilities" WHERE "configuration_id" = '00000000-0000-4000-8000-000000000040'::uuid AND "configuration_version" IN (1, 2) AND "facility_id" = ANY(synthetic_facility_ids)) +
		(SELECT count(*) FROM public."roster_source_configuration_groups" WHERE "configuration_id" = '00000000-0000-4000-8000-000000000040'::uuid AND "configuration_version" IN (1, 2) AND "population" = 'synthetic' AND "group_source_id" = ANY(synthetic_group_ids) AND "group_source_kind" = 'synthetic') +
		(SELECT count(*) FROM public."roster_snapshots" WHERE "id" = '00000000-0000-4000-8000-000000000041'::uuid AND "version" = 1 AND "population" = 'synthetic' AND "source_configuration_id" = '00000000-0000-4000-8000-000000000040'::uuid AND "source_configuration_version" = 1) +
		(SELECT count(*) FROM public."roster_snapshot_facilities" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid AND "facility_id" = ANY(synthetic_facility_ids)) +
		(SELECT count(*) FROM public."roster_snapshot_sources" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid AND "population" = 'synthetic' AND "group_source_id" = ANY(synthetic_group_ids) AND "group_source_kind" = 'synthetic') +
		(SELECT count(*) FROM public."roster_recipients" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid AND "id" = ANY(synthetic_recipient_ids) AND "population" = 'synthetic' AND "google_subject" IS NULL AND "staff_email" IS NULL) +
		(SELECT count(*) FROM public."roster_recipient_group_sources" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid AND "recipient_id" = ANY(synthetic_recipient_ids) AND "population" = 'synthetic' AND "group_source_id" = ANY(synthetic_group_ids) AND "group_source_kind" = 'synthetic') +
		(SELECT count(*) FROM public."roster_endpoints" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid AND "recipient_id" = ANY(synthetic_recipient_ids) AND "id" = ANY(synthetic_endpoint_ids) AND "population" = 'synthetic' AND "captured_at" = '2026-08-06 12:00:00+00'::timestamptz AND (("channel" = 'push' AND "token" LIKE 'synthetic-unroutable:%' AND "email" IS NULL AND "phone_number" IS NULL) OR ("channel" = 'email' AND "token" IS NULL AND "email" LIKE '%@example.invalid' AND "phone_number" IS NULL) OR ("channel" = 'sms' AND "token" IS NULL AND "email" IS NULL AND "phone_number" LIKE '+120255501__')))
	INTO graph_row_count;
	IF graph_row_count <> expected_graph_row_count THEN
		RAISE EXCEPTION 'Canonical synthetic facility % graph matched % of % approved rows', graph_variant, graph_row_count, expected_graph_row_count
			USING ERRCODE = '55000';
	END IF;

	-- This digest covers every column of every approved canonical row.
	-- It makes the deletion fail closed if even an unroutable endpoint value,
	-- recipient link, configuration timestamp, or target ordinal has changed.
	SELECT pg_catalog.md5(pg_catalog.jsonb_build_object(
		'facilities', (SELECT pg_catalog.jsonb_agg(to_jsonb(row_value) ORDER BY "id") FROM public."facilities" AS row_value WHERE "id" = ANY(synthetic_facility_ids)),
		'neighborhood_versions', (SELECT pg_catalog.jsonb_agg(to_jsonb(row_value) ORDER BY "id", "version") FROM public."neighborhood_versions" AS row_value WHERE "id" = '00000000-0000-4000-8000-000000000010'::uuid),
		'neighborhood_facilities', (SELECT pg_catalog.jsonb_agg(to_jsonb(row_value) ORDER BY "neighborhood_id", "neighborhood_version", "facility_id") FROM public."neighborhood_facilities" AS row_value WHERE "neighborhood_id" = '00000000-0000-4000-8000-000000000010'::uuid),
		'group_sources', (SELECT pg_catalog.jsonb_agg(to_jsonb(row_value) ORDER BY "id") FROM public."group_sources" AS row_value WHERE "id" = ANY(synthetic_group_ids)),
		'audience_configurations', (SELECT pg_catalog.jsonb_agg(to_jsonb(row_value) ORDER BY "id", "version") FROM public."audience_configurations" AS row_value WHERE "id" = ANY(synthetic_audience_ids)),
		'audience_targets', (SELECT pg_catalog.jsonb_agg(to_jsonb(row_value) ORDER BY "audience_config_id", "audience_config_version", "ordinal") FROM public."audience_targets" AS row_value WHERE "audience_config_id" = ANY(synthetic_audience_ids)),
		'configurations', (SELECT pg_catalog.jsonb_agg(to_jsonb(row_value) ORDER BY "id", "version") FROM public."roster_source_configurations" AS row_value WHERE "id" = '00000000-0000-4000-8000-000000000040'::uuid),
		'configuration_facilities', (SELECT pg_catalog.jsonb_agg(to_jsonb(row_value) ORDER BY "configuration_id", "configuration_version", "facility_id") FROM public."roster_source_configuration_facilities" AS row_value WHERE "configuration_id" = '00000000-0000-4000-8000-000000000040'::uuid),
		'configuration_groups', (SELECT pg_catalog.jsonb_agg(to_jsonb(row_value) ORDER BY "configuration_id", "configuration_version", "group_source_id") FROM public."roster_source_configuration_groups" AS row_value WHERE "configuration_id" = '00000000-0000-4000-8000-000000000040'::uuid),
		'snapshots', (SELECT pg_catalog.jsonb_agg(to_jsonb(row_value) ORDER BY "id") FROM public."roster_snapshots" AS row_value WHERE "id" = '00000000-0000-4000-8000-000000000041'::uuid),
		'snapshot_facilities', (SELECT pg_catalog.jsonb_agg(to_jsonb(row_value) ORDER BY "roster_snapshot_id", "facility_id") FROM public."roster_snapshot_facilities" AS row_value WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid),
		'snapshot_sources', (SELECT pg_catalog.jsonb_agg(to_jsonb(row_value) ORDER BY "roster_snapshot_id", "group_source_id", "completion_kind") FROM public."roster_snapshot_sources" AS row_value WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid),
		'recipients', (SELECT pg_catalog.jsonb_agg(to_jsonb(row_value) ORDER BY "roster_snapshot_id", "id") FROM public."roster_recipients" AS row_value WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid),
		'recipient_groups', (SELECT pg_catalog.jsonb_agg(to_jsonb(row_value) ORDER BY "roster_snapshot_id", "recipient_id", "group_source_id") FROM public."roster_recipient_group_sources" AS row_value WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid),
		'endpoints', (SELECT pg_catalog.jsonb_agg(to_jsonb(row_value) ORDER BY "roster_snapshot_id", "recipient_id", "id") FROM public."roster_endpoints" AS row_value WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid)
	)::text) INTO graph_fingerprint;
	IF graph_fingerprint <> expected_graph_fingerprint THEN
		RAISE EXCEPTION 'Canonical synthetic facility % graph fingerprint does not match the approved % rows', graph_variant, expected_graph_row_count
			USING ERRCODE = '55000';
	END IF;

	SELECT
		(SELECT count(*) FROM public."neighborhood_versions" WHERE "id" = '00000000-0000-4000-8000-000000000010'::uuid) +
		(SELECT count(*) FROM public."neighborhood_facilities" WHERE "neighborhood_id" = '00000000-0000-4000-8000-000000000010'::uuid) +
		(SELECT count(*) FROM public."group_sources" WHERE "id" = ANY(synthetic_group_ids)) +
		(SELECT count(*) FROM public."audience_configurations" WHERE "id" = ANY(synthetic_audience_ids)) +
		(SELECT count(*) FROM public."audience_targets" WHERE "audience_config_id" = ANY(synthetic_audience_ids)) +
		(SELECT count(*) FROM public."roster_source_configurations" WHERE "id" = '00000000-0000-4000-8000-000000000040'::uuid) +
		(SELECT count(*) FROM public."roster_source_configuration_facilities" WHERE "configuration_id" = '00000000-0000-4000-8000-000000000040'::uuid) +
		(SELECT count(*) FROM public."roster_source_configuration_groups" WHERE "configuration_id" = '00000000-0000-4000-8000-000000000040'::uuid) +
		(SELECT count(*) FROM public."roster_snapshots" WHERE "id" = '00000000-0000-4000-8000-000000000041'::uuid) +
		(SELECT count(*) FROM public."roster_snapshot_facilities" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid) +
		(SELECT count(*) FROM public."roster_snapshot_sources" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid) +
		(SELECT count(*) FROM public."roster_recipients" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid) +
		(SELECT count(*) FROM public."roster_recipient_group_sources" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid) +
		(SELECT count(*) FROM public."roster_endpoints" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid)
	INTO dependency_count;
	IF dependency_count <> expected_dependency_count THEN
		RAISE EXCEPTION 'Canonical synthetic descendant graph contains extra or missing rows'
			USING ERRCODE = '55000';
	END IF;

	SELECT
		(SELECT count(*) FROM public."neighborhood_facilities" WHERE "facility_id" = ANY(synthetic_facility_ids) AND ("neighborhood_id", "neighborhood_version") <> ('00000000-0000-4000-8000-000000000010'::uuid, 1)) +
		(SELECT count(*) FROM public."group_sources" WHERE "facility_id" = ANY(synthetic_facility_ids) AND NOT ("id" = ANY(synthetic_group_ids))) +
		(SELECT count(*) FROM public."audience_configurations" WHERE "facility_id" = ANY(synthetic_facility_ids) AND NOT ("id" = ANY(synthetic_audience_ids) AND "version" = 1)) +
		(SELECT count(*) FROM public."audience_targets" WHERE ("target_facility_id" = ANY(synthetic_facility_ids) OR "neighborhood_id" = '00000000-0000-4000-8000-000000000010'::uuid OR "group_source_id" = ANY(synthetic_group_ids)) AND NOT ("audience_config_id" = ANY(synthetic_audience_ids) AND "audience_config_version" = 1)) +
		(SELECT count(*) FROM public."roster_source_configuration_facilities" WHERE "facility_id" = ANY(synthetic_facility_ids) AND "configuration_id" <> '00000000-0000-4000-8000-000000000040'::uuid) +
		(SELECT count(*) FROM public."roster_source_configuration_groups" WHERE "group_source_id" = ANY(synthetic_group_ids) AND "configuration_id" <> '00000000-0000-4000-8000-000000000040'::uuid) +
		(SELECT count(*) FROM public."roster_snapshots" WHERE "source_configuration_id" = '00000000-0000-4000-8000-000000000040'::uuid AND "id" <> '00000000-0000-4000-8000-000000000041'::uuid) +
		(SELECT count(*) FROM public."roster_snapshot_facilities" WHERE "facility_id" = ANY(synthetic_facility_ids) AND "roster_snapshot_id" <> '00000000-0000-4000-8000-000000000041'::uuid) +
		(SELECT count(*) FROM public."roster_snapshot_sources" WHERE "group_source_id" = ANY(synthetic_group_ids) AND "roster_snapshot_id" <> '00000000-0000-4000-8000-000000000041'::uuid) +
		(SELECT count(*) FROM public."roster_recipient_group_sources" WHERE ("recipient_id" = ANY(synthetic_recipient_ids) OR "group_source_id" = ANY(synthetic_group_ids)) AND "roster_snapshot_id" <> '00000000-0000-4000-8000-000000000041'::uuid) +
		(SELECT count(*) FROM public."roster_endpoints" WHERE ("id" = ANY(synthetic_endpoint_ids) OR "recipient_id" = ANY(synthetic_recipient_ids)) AND "roster_snapshot_id" <> '00000000-0000-4000-8000-000000000041'::uuid) +
		(SELECT count(*) FROM public."access_membership_snapshot_groups" WHERE "group_source_id" = ANY(synthetic_group_ids)) +
		(SELECT count(*) FROM public."access_membership_member_groups" WHERE "group_source_id" = ANY(synthetic_group_ids)) +
		(SELECT count(*) FROM public."access_membership_member_facilities" WHERE "facility_id" = ANY(synthetic_facility_ids)) +
		(SELECT count(*) FROM public."user_facility_scopes" WHERE "facility_id" = ANY(synthetic_facility_ids)) +
		(SELECT count(*) FROM public."agent_api_key_facilities" WHERE "facility_id" = ANY(synthetic_facility_ids)) +
		(SELECT count(*) FROM public."roster_sync_results" WHERE "source_configuration_id" = '00000000-0000-4000-8000-000000000040'::uuid OR "published_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid) +
		(SELECT count(*) FROM public."roster_sync_result_sources" WHERE "group_source_id" = ANY(synthetic_group_ids)) +
		(SELECT count(*) FROM public."roster_sync_group_failures" WHERE "group_source_id" = ANY(synthetic_group_ids)) +
		(SELECT count(*) FROM public."activation_previews" WHERE "facility_id" = ANY(synthetic_facility_ids) OR "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid OR "audience_config_id" = ANY(synthetic_audience_ids)) +
		(SELECT count(*) FROM public."prepared_activations" WHERE "facility_id" = ANY(synthetic_facility_ids) OR "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid OR "audience_config_id" = ANY(synthetic_audience_ids)) +
		(SELECT count(*) FROM public."prepared_activation_consumptions" WHERE "facility_id" = ANY(synthetic_facility_ids) OR "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid OR "audience_config_id" = ANY(synthetic_audience_ids)) +
		(SELECT count(*) FROM public."events" WHERE "facility_id" = ANY(synthetic_facility_ids) OR "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid) +
		(SELECT count(*) FROM public."event_transitions" WHERE "event_id" IN (SELECT "id" FROM public."events" WHERE "facility_id" = ANY(synthetic_facility_ids) OR "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid)) +
		(SELECT count(*) FROM public."journal_entries" WHERE "event_id" IN (SELECT "id" FROM public."events" WHERE "facility_id" = ANY(synthetic_facility_ids) OR "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid)) +
		(SELECT count(*) FROM public."media_upload_intents" WHERE "facility_id" = ANY(synthetic_facility_ids) OR "event_id" IN (SELECT "id" FROM public."events" WHERE "facility_id" = ANY(synthetic_facility_ids) OR "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid)) +
		(SELECT count(*) FROM public."media_records" WHERE "event_id" IN (SELECT "id" FROM public."events" WHERE "facility_id" = ANY(synthetic_facility_ids) OR "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid)) +
		(SELECT count(*) FROM public."lifecycle_consequence_previews" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid OR "audience_config_id" = ANY(synthetic_audience_ids)) +
		(SELECT count(*) FROM public."notification_intents" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid OR "audience_config_id" = ANY(synthetic_audience_ids)) +
		(SELECT count(*) FROM public."notification_intent_channels" WHERE "intent_id" IN (SELECT "id" FROM public."notification_intents" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid OR "audience_config_id" = ANY(synthetic_audience_ids))) +
		(SELECT count(*) FROM public."fanout_intent_authorizations" WHERE "intent_id" IN (SELECT "id" FROM public."notification_intents" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid OR "audience_config_id" = ANY(synthetic_audience_ids))) +
		(SELECT count(*) FROM public."outbox" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid OR "audience_config_id" = ANY(synthetic_audience_ids)) +
		(SELECT count(*) FROM public."dispatch_batches" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid OR "audience_config_id" = ANY(synthetic_audience_ids)) +
		(SELECT count(*) FROM public."channel_attempts" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid) +
		(SELECT count(*) FROM public."delivery_evidence" WHERE "intent_id" IN (SELECT "id" FROM public."notification_intents" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid OR "audience_config_id" = ANY(synthetic_audience_ids)) OR "attempt_id" IN (SELECT "id" FROM public."channel_attempts" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid)) +
		(SELECT count(*) FROM public."delivery_test_canary_eligibility_facts" WHERE "facility_id" = ANY(synthetic_facility_ids) OR "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid) +
		(SELECT count(*) FROM public."delivery_test_target_set_versions" WHERE "facility_id" = ANY(synthetic_facility_ids) OR "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid) +
		(SELECT count(*) FROM public."delivery_test_target_endpoints" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid OR "recipient_id" = ANY(synthetic_recipient_ids) OR "endpoint_id" = ANY(synthetic_endpoint_ids)) +
		(SELECT count(*) FROM public."delivery_test_runs" WHERE "event_id" IN (SELECT "id" FROM public."events" WHERE "facility_id" = ANY(synthetic_facility_ids) OR "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid) OR "notification_intent_id" IN (SELECT "id" FROM public."notification_intents" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid OR "audience_config_id" = ANY(synthetic_audience_ids)) OR "target_set_version_id" IN (SELECT "id" FROM public."delivery_test_target_set_versions" WHERE "facility_id" = ANY(synthetic_facility_ids) OR "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid)) +
		(SELECT count(*) FROM public."delivery_test_reports" WHERE "run_id" IN (SELECT "id" FROM public."delivery_test_runs" WHERE "event_id" IN (SELECT "id" FROM public."events" WHERE "facility_id" = ANY(synthetic_facility_ids) OR "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid) OR "notification_intent_id" IN (SELECT "id" FROM public."notification_intents" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid OR "audience_config_id" = ANY(synthetic_audience_ids)) OR "target_set_version_id" IN (SELECT "id" FROM public."delivery_test_target_set_versions" WHERE "facility_id" = ANY(synthetic_facility_ids) OR "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid))) +
		(SELECT count(*) FROM public."endpoint_status_records" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid) +
		(SELECT count(*) FROM public."sms_opt_out_records" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid)
	INTO dependency_count;
	IF dependency_count <> 0 THEN
		RAISE EXCEPTION 'Canonical synthetic facility graph has operational, event, delivery, access, or mixed dependencies'
			USING ERRCODE = '55000';
	END IF;

	-- The reviewed-live variant retains its two exact audit rows and completed
	-- idempotency record; the pristine variant requires none of those semantic
	-- references. Full-row digests protect all other truth without embedding
	-- principal/action JSON in the migration or its logs.
	SELECT count(*)::integer INTO audit_reference_count
	FROM public."security_audit_entries"
	WHERE "facility_id" = ANY(synthetic_facility_ids);
	IF graph_variant = 'reviewed-live' AND (audit_reference_count <> 2 OR (
		SELECT count(*)
		FROM public."security_audit_entries" AS audit_entry
		WHERE (
			"sequence" = 56
			AND "facility_id" = '00000000-0000-4000-8000-000000000001'::uuid
			AND "previous_hash" = '84e1a8da4b36b17991f640e16aefba018aac2ed6d8af7c390895cb133a4dd26f'
			AND "entry_hash" = '8e7cd227e4b9b725834acdb718866e0156b47fbdd6184136c83eec7f4077b2da'
			AND "outcome" = 'success'
			AND "request_id" = 'b240eb97-75a4-4051-8cc6-fc4b6d332fb1'::uuid
			AND "reason_code" IS NULL
			AND "occurred_at" = '2026-08-16 20:49:06.445+00'::timestamptz
		) OR (
			"sequence" = 58
			AND "facility_id" = '00000000-0000-4000-8000-000000000002'::uuid
			AND "previous_hash" = '58cc600f619a9368e945c88ac5c9f9032e576ddd5649361c0ec96b95e1d43758'
			AND "entry_hash" = '8e91c4c142960f5149d6a5375c4dc7d1546d7fd94fa4325dc2535b2fab4393ff'
			AND "outcome" = 'failure'
			AND "request_id" = 'e95abdfc-26f6-44aa-b3fb-3fac41eeadb8'::uuid
			AND "reason_code" = 'PERSISTENCE_CONFLICT'
			AND "occurred_at" = '2026-08-16 20:49:22.839+00'::timestamptz
		)
	) <> 2 OR (
		SELECT count(*)
		FROM public."security_audit_chain_anchors"
		WHERE ("sequence", "entry_hash") IN (
			(56, '8e7cd227e4b9b725834acdb718866e0156b47fbdd6184136c83eec7f4077b2da'),
			(58, '8e91c4c142960f5149d6a5375c4dc7d1546d7fd94fa4325dc2535b2fab4393ff')
		)
	) <> 2) THEN
		RAISE EXCEPTION 'Retained synthetic facility audit fingerprints do not match the read-only live review'
			USING ERRCODE = '55000';
	END IF;
	IF graph_variant = 'pristine-seed' AND audit_reference_count <> 0 THEN
		RAISE EXCEPTION 'Pristine canonical synthetic facility graph has unexpected retained audit references'
			USING ERRCODE = '55000';
	END IF;

	IF graph_variant = 'reviewed-live' AND (
		SELECT count(*)
		FROM public."idempotency_records" AS idempotency_record
		WHERE "id" = '81ec2daa-83e7-4ded-a914-b72bdda54e8e'::uuid
			AND "capability_id" = 'update-facility'
			AND "status" = 'completed'
			AND "created_at" = '2026-08-16 20:49:06.445+00'::timestamptz
			AND "completed_at" = '2026-08-16 20:49:06.445+00'::timestamptz
	) <> 1 THEN
		RAISE EXCEPTION 'Retained synthetic facility idempotency fingerprint does not match the read-only live review'
			USING ERRCODE = '55000';
	END IF;
	IF graph_variant = 'pristine-seed' AND (
		SELECT count(*) FROM public."idempotency_records"
		WHERE "id" = '81ec2daa-83e7-4ded-a914-b72bdda54e8e'::uuid
	) <> 0 THEN
		RAISE EXCEPTION 'Pristine canonical synthetic facility graph has the reviewed live idempotency record'
			USING ERRCODE = '55000';
	END IF;

	SELECT count(*)::integer,
		pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(to_jsonb(facility_row) ORDER BY "id")::text, 'null'))
	INTO real_facility_count, real_facilities_digest_before
	FROM public."facilities" AS facility_row
	WHERE "id" <> ALL(synthetic_facility_ids);
	IF graph_variant = 'reviewed-live' AND real_facility_count <> 20 THEN
		RAISE EXCEPTION 'Expected the 20 reviewed real facilities; found %', real_facility_count
			USING ERRCODE = '55000';
	END IF;

	SELECT count(DISTINCT "id")::integer INTO real_neighborhood_count
	FROM public."neighborhood_versions"
	WHERE "id" <> '00000000-0000-4000-8000-000000000010'::uuid;
	IF graph_variant = 'reviewed-live' AND real_neighborhood_count <> 4 THEN
		RAISE EXCEPTION 'Expected the 4 reviewed real neighborhoods; found %', real_neighborhood_count
			USING ERRCODE = '55000';
	END IF;
	SELECT pg_catalog.md5(pg_catalog.jsonb_build_object(
		'versions', (SELECT pg_catalog.jsonb_agg(to_jsonb(neighborhood_row) ORDER BY "id", "version") FROM public."neighborhood_versions" AS neighborhood_row WHERE "id" <> '00000000-0000-4000-8000-000000000010'::uuid),
		'facilities', (SELECT pg_catalog.jsonb_agg(to_jsonb(membership_row) ORDER BY "neighborhood_id", "neighborhood_version", "facility_id") FROM public."neighborhood_facilities" AS membership_row WHERE "neighborhood_id" <> '00000000-0000-4000-8000-000000000010'::uuid)
	)::text) INTO real_neighborhoods_digest_before;

	SELECT pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(to_jsonb(audit_row) ORDER BY "sequence")::text, 'null'))
	INTO audit_digest_before FROM public."security_audit_entries" AS audit_row;
	SELECT pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(to_jsonb(anchor_row) ORDER BY "sequence")::text, 'null'))
	INTO audit_anchor_digest_before FROM public."security_audit_chain_anchors" AS anchor_row;
	SELECT pg_catalog.jsonb_build_object('sequence', "sequence", 'entryHash', "entry_hash")
	INTO audit_head_before FROM public."security_audit_chain_anchors"
	ORDER BY "sequence" DESC LIMIT 1;
	SELECT pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(to_jsonb(idempotency_row) ORDER BY "id")::text, 'null'))
	INTO idempotency_digest_before FROM public."idempotency_records" AS idempotency_row;

	FOREACH table_name IN ARRAY affected_tables LOOP
		SELECT count(*)::integer INTO guard_count
		FROM pg_catalog.pg_trigger AS trigger
		JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
		JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		WHERE namespace.nspname = 'public'
			AND relation.relname = table_name
			AND trigger.tgname = table_name || '_retain_guard'
			AND trigger.tgenabled = 'O'
			AND trigger.tgtype = 11
			AND trigger.tgfoid = 'public.psd_eoc_reject_delete()'::pg_catalog.regprocedure
			AND NOT trigger.tgisinternal;
		IF guard_count <> 1 THEN
			RAISE EXCEPTION 'Retain guard is absent or disabled on %', table_name
				USING ERRCODE = '55000';
		END IF;
		EXECUTE pg_catalog.format('DROP TRIGGER %I ON public.%I', table_name || '_retain_guard', table_name);
	END LOOP;

	DELETE FROM public."roster_endpoints" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid;
	GET DIAGNOSTICS deleted_count = ROW_COUNT; deleted_total := deleted_total + deleted_count;
	DELETE FROM public."roster_recipient_group_sources" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid;
	GET DIAGNOSTICS deleted_count = ROW_COUNT; deleted_total := deleted_total + deleted_count;
	DELETE FROM public."roster_recipients" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid;
	GET DIAGNOSTICS deleted_count = ROW_COUNT; deleted_total := deleted_total + deleted_count;
	DELETE FROM public."roster_snapshot_sources" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid;
	GET DIAGNOSTICS deleted_count = ROW_COUNT; deleted_total := deleted_total + deleted_count;
	DELETE FROM public."roster_snapshot_facilities" WHERE "roster_snapshot_id" = '00000000-0000-4000-8000-000000000041'::uuid;
	GET DIAGNOSTICS deleted_count = ROW_COUNT; deleted_total := deleted_total + deleted_count;
	DELETE FROM public."roster_snapshots" WHERE "id" = '00000000-0000-4000-8000-000000000041'::uuid;
	GET DIAGNOSTICS deleted_count = ROW_COUNT; deleted_total := deleted_total + deleted_count;
	DELETE FROM public."roster_source_configuration_groups" WHERE "configuration_id" = '00000000-0000-4000-8000-000000000040'::uuid;
	GET DIAGNOSTICS deleted_count = ROW_COUNT; deleted_total := deleted_total + deleted_count;
	DELETE FROM public."roster_source_configuration_facilities" WHERE "configuration_id" = '00000000-0000-4000-8000-000000000040'::uuid;
	GET DIAGNOSTICS deleted_count = ROW_COUNT; deleted_total := deleted_total + deleted_count;
	DELETE FROM public."roster_source_configurations" WHERE "id" = '00000000-0000-4000-8000-000000000040'::uuid;
	GET DIAGNOSTICS deleted_count = ROW_COUNT; deleted_total := deleted_total + deleted_count;
	DELETE FROM public."audience_targets" WHERE "audience_config_id" = ANY(synthetic_audience_ids);
	GET DIAGNOSTICS deleted_count = ROW_COUNT; deleted_total := deleted_total + deleted_count;
	DELETE FROM public."audience_configurations" WHERE "id" = ANY(synthetic_audience_ids);
	GET DIAGNOSTICS deleted_count = ROW_COUNT; deleted_total := deleted_total + deleted_count;
	DELETE FROM public."neighborhood_facilities" WHERE "neighborhood_id" = '00000000-0000-4000-8000-000000000010'::uuid;
	GET DIAGNOSTICS deleted_count = ROW_COUNT; deleted_total := deleted_total + deleted_count;
	DELETE FROM public."neighborhood_versions" WHERE "id" = '00000000-0000-4000-8000-000000000010'::uuid;
	GET DIAGNOSTICS deleted_count = ROW_COUNT; deleted_total := deleted_total + deleted_count;
	DELETE FROM public."group_sources" WHERE "id" = ANY(synthetic_group_ids);
	GET DIAGNOSTICS deleted_count = ROW_COUNT; deleted_total := deleted_total + deleted_count;
	DELETE FROM public."facilities" WHERE "id" = ANY(synthetic_facility_ids);
	GET DIAGNOSTICS deleted_count = ROW_COUNT; deleted_total := deleted_total + deleted_count;

	IF deleted_total <> expected_graph_row_count THEN
		RAISE EXCEPTION 'Canonical synthetic facility purge deleted % rows instead of %', deleted_total, expected_graph_row_count
			USING ERRCODE = '55000';
	END IF;

	FOREACH table_name IN ARRAY affected_tables LOOP
		EXECUTE pg_catalog.format(
			'CREATE TRIGGER %I BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.psd_eoc_reject_delete()',
			table_name || '_retain_guard', table_name
		);
		SELECT count(*)::integer INTO guard_count
		FROM pg_catalog.pg_trigger AS trigger
		JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
		JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		WHERE namespace.nspname = 'public'
			AND relation.relname = table_name
			AND trigger.tgname = table_name || '_retain_guard'
			AND trigger.tgenabled = 'O'
			AND trigger.tgtype = 11
			AND trigger.tgfoid = 'public.psd_eoc_reject_delete()'::pg_catalog.regprocedure
			AND NOT trigger.tgisinternal;
		IF guard_count <> 1 THEN
			RAISE EXCEPTION 'Retain guard was not restored exactly on %', table_name
				USING ERRCODE = '55000';
		END IF;
		IF pg_catalog.has_table_privilege(
			'psd_eoc_app', pg_catalog.format('public.%I', table_name), 'DELETE'
		) THEN
			RAISE EXCEPTION 'Application role unexpectedly has DELETE on %', table_name
				USING ERRCODE = '55000';
		END IF;
	END LOOP;

	IF EXISTS (
		SELECT 1 FROM public."facilities"
		WHERE "id" = ANY(synthetic_facility_ids)
			OR "code" IN ('SYN-NORTH', 'SYN-SOUTH')
	) OR EXISTS (
		SELECT 1 FROM public."neighborhood_versions"
		WHERE "id" = '00000000-0000-4000-8000-000000000010'::uuid
			OR "name" = 'Synthetic Twin Campuses'
	) OR EXISTS (
		SELECT 1 FROM public."group_sources"
		WHERE "id" = ANY(synthetic_group_ids)
			OR "fixture_key" IN (
				'synthetic-north-staff', 'synthetic-south-staff',
				'synthetic-district-support-staff'
			)
	) OR EXISTS (
		SELECT 1 FROM public."audience_configurations"
		WHERE "id" = ANY(synthetic_audience_ids)
	) OR EXISTS (
		SELECT 1 FROM public."roster_source_configurations"
		WHERE "id" = '00000000-0000-4000-8000-000000000040'::uuid
	) OR EXISTS (
		SELECT 1 FROM public."roster_snapshots"
		WHERE "id" = '00000000-0000-4000-8000-000000000041'::uuid
	) OR EXISTS (
		SELECT 1 FROM public."roster_recipients"
		WHERE "id" = ANY(synthetic_recipient_ids)
	) OR EXISTS (
		SELECT 1 FROM public."roster_endpoints"
		WHERE "id" = ANY(synthetic_endpoint_ids)
	) OR (
		SELECT count(*) FROM public."security_audit_facility_anchors"
		WHERE "facility_id" = ANY(synthetic_facility_ids)
	) <> 2 THEN
		RAISE EXCEPTION 'Canonical synthetic facility purge postcondition failed'
			USING ERRCODE = '55000';
	END IF;

	IF audit_digest_before IS DISTINCT FROM (
		SELECT pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(to_jsonb(audit_row) ORDER BY "sequence")::text, 'null'))
		FROM public."security_audit_entries" AS audit_row
	) OR audit_anchor_digest_before IS DISTINCT FROM (
		SELECT pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(to_jsonb(anchor_row) ORDER BY "sequence")::text, 'null'))
		FROM public."security_audit_chain_anchors" AS anchor_row
	) OR audit_head_before IS DISTINCT FROM (
		SELECT pg_catalog.jsonb_build_object('sequence', "sequence", 'entryHash', "entry_hash")
		FROM public."security_audit_chain_anchors"
		ORDER BY "sequence" DESC LIMIT 1
	) OR idempotency_digest_before IS DISTINCT FROM (
		SELECT pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(to_jsonb(idempotency_row) ORDER BY "id")::text, 'null'))
		FROM public."idempotency_records" AS idempotency_row
	) OR real_facilities_digest_before IS DISTINCT FROM (
		SELECT pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(to_jsonb(facility_row) ORDER BY "id")::text, 'null'))
		FROM public."facilities" AS facility_row
	) OR real_neighborhoods_digest_before IS DISTINCT FROM (
		SELECT pg_catalog.md5(pg_catalog.jsonb_build_object(
			'versions', (SELECT pg_catalog.jsonb_agg(to_jsonb(neighborhood_row) ORDER BY "id", "version") FROM public."neighborhood_versions" AS neighborhood_row),
			'facilities', (SELECT pg_catalog.jsonb_agg(to_jsonb(membership_row) ORDER BY "neighborhood_id", "neighborhood_version", "facility_id") FROM public."neighborhood_facilities" AS membership_row)
		)::text)
	) THEN
		RAISE EXCEPTION 'Retained audit, idempotency, facility, or neighborhood truth changed during purge'
			USING ERRCODE = '55000';
	END IF;

	IF NOT pg_catalog.has_table_privilege(
		'psd_eoc_app', 'public.security_audit_facility_anchors', 'SELECT'
	) OR pg_catalog.has_table_privilege(
		'psd_eoc_app', 'public.security_audit_facility_anchors', 'INSERT'
	) OR pg_catalog.has_table_privilege(
		'psd_eoc_app', 'public.security_audit_facility_anchors', 'UPDATE'
	) OR pg_catalog.has_table_privilege(
		'psd_eoc_app', 'public.security_audit_facility_anchors', 'DELETE'
	) OR pg_catalog.has_table_privilege(
		'psd_eoc_app', 'public.security_audit_facility_anchors', 'TRUNCATE'
	) OR pg_catalog.has_table_privilege(
		'psd_eoc_app', 'public.security_audit_facility_anchors', 'REFERENCES'
	) OR pg_catalog.has_table_privilege(
		'psd_eoc_app', 'public.security_audit_facility_anchors', 'TRIGGER'
	) OR pg_catalog.has_function_privilege(
		'psd_eoc_app', 'public.psd_eoc_anchor_facility_insert()', 'EXECUTE'
	) OR (
		SELECT count(*) FROM pg_catalog.pg_trigger AS trigger
		WHERE trigger.tgrelid = 'public.security_audit_facility_anchors'::pg_catalog.regclass
			AND trigger.tgname = 'security_audit_facility_anchors_immutable_guard'
			AND trigger.tgenabled = 'O'
			AND trigger.tgtype = 27
			AND trigger.tgfoid = 'public.psd_eoc_reject_immutable_mutation()'::pg_catalog.regprocedure
			AND NOT trigger.tgisinternal
	) <> 1 THEN
		RAISE EXCEPTION 'Audit facility anchor immutability or application privileges are not fail closed'
			USING ERRCODE = '55000';
	END IF;
END;
$$;
--> statement-breakpoint
