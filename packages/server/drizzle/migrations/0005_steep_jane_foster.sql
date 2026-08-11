-- Refuse to begin the upgrade while any touched table is in use. Acquiring
-- every existing table at the final DDL strength in one order avoids both
-- lock upgrades and mixing migration locks with runtime advisory-lock order.
LOCK TABLE
	public."users",
	public."sessions",
	public."integration_statuses",
	public."channel_configurations",
	public."roster_source_configurations",
	public."roster_source_configuration_facilities",
	public."roster_source_configuration_groups",
	public."roster_snapshots",
	public."roster_snapshot_facilities",
	public."roster_snapshot_sources",
	public."roster_recipients",
	public."roster_recipient_group_sources",
	public."roster_endpoints",
	public."neighborhood_versions",
	public."neighborhood_facilities",
	public."audience_configurations",
	public."audience_targets",
	public."user_roles"
IN ACCESS EXCLUSIVE MODE NOWAIT;--> statement-breakpoint

CREATE TABLE "integration_channel_change_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(255) NOT NULL,
	"authorization_commitment" varchar(64) NOT NULL,
	"integration_status_id" uuid NOT NULL,
	"integration_id" varchar(100) NOT NULL,
	"status_label" "integration_truth_label" NOT NULL,
	"desired_enabled" boolean NOT NULL,
	"request_digest" varchar(64) NOT NULL,
	"consequence_digest" varchar(64) NOT NULL,
	"authorized_by_user_id" uuid NOT NULL,
	"authorized_with_session_id" uuid NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_by_user_id" uuid NOT NULL,
	"consumed_with_session_id" uuid NOT NULL,
	"consumed_request_id" uuid NOT NULL,
	"consumed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "channel_change_authorizations_reference_uq" UNIQUE("reference"),
	CONSTRAINT "channel_change_authorizations_status_uq" UNIQUE("integration_status_id"),
	CONSTRAINT "channel_change_authorizations_commitment_uq" UNIQUE("authorization_commitment"),
	CONSTRAINT "channel_change_authorizations_request_uq" UNIQUE("consumed_request_id"),
	CONSTRAINT "channel_change_authorizations_live_status" CHECK ("integration_channel_change_authorizations"."status_label" = 'live-verified'),
	CONSTRAINT "channel_change_authorizations_same_human_session" CHECK ("integration_channel_change_authorizations"."authorized_by_user_id" = "integration_channel_change_authorizations"."consumed_by_user_id"
        and "integration_channel_change_authorizations"."authorized_with_session_id" = "integration_channel_change_authorizations"."consumed_with_session_id"),
	CONSTRAINT "channel_change_authorizations_reference_format" CHECK ("integration_channel_change_authorizations"."reference" = btrim("integration_channel_change_authorizations"."reference")
        and length("integration_channel_change_authorizations"."reference") between 1 and 255),
	CONSTRAINT "channel_change_authorizations_integration_id_format" CHECK ("integration_channel_change_authorizations"."integration_id" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
	CONSTRAINT "channel_change_authorizations_digest_format" CHECK ("integration_channel_change_authorizations"."authorization_commitment" ~ '^[a-f0-9]{64}$'
        and "integration_channel_change_authorizations"."request_digest" ~ '^[a-f0-9]{64}$'
        and "integration_channel_change_authorizations"."consequence_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "channel_change_authorizations_timestamp_precision" CHECK ("integration_channel_change_authorizations"."issued_at" = date_trunc('milliseconds', "integration_channel_change_authorizations"."issued_at")
        and "integration_channel_change_authorizations"."expires_at" = date_trunc('milliseconds', "integration_channel_change_authorizations"."expires_at")
        and "integration_channel_change_authorizations"."consumed_at" = date_trunc('milliseconds', "integration_channel_change_authorizations"."consumed_at")),
	CONSTRAINT "channel_change_authorizations_expiry_bound" CHECK ("integration_channel_change_authorizations"."expires_at" > "integration_channel_change_authorizations"."issued_at"
        and "integration_channel_change_authorizations"."expires_at" <= "integration_channel_change_authorizations"."issued_at" + interval '15 minutes'),
	CONSTRAINT "channel_change_authorizations_consumption_time" CHECK ("integration_channel_change_authorizations"."consumed_at" between "integration_channel_change_authorizations"."issued_at" and "integration_channel_change_authorizations"."expires_at")
);
--> statement-breakpoint
CREATE TABLE "user_role_changes" (
	"sequence" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	"granted" boolean NOT NULL,
	"changed_by_user_id" uuid NOT NULL,
	"changed_with_session_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_role_changes_request_user_role_uq" UNIQUE("request_id","user_id","role"),
	CONSTRAINT "user_role_changes_sequence_positive" CHECK ("user_role_changes"."sequence" > 0)
);
--> statement-breakpoint
ALTER TABLE "integration_statuses" ADD CONSTRAINT "integration_statuses_channel_authorization_anchor_uq" UNIQUE("id","integration_id","label","verified_by_user_id","authorization_reference","verified_at");--> statement-breakpoint
ALTER TABLE "integration_channel_change_authorizations" ADD CONSTRAINT "channel_change_authorizations_status_truth_fk" FOREIGN KEY ("integration_status_id","integration_id","status_label","authorized_by_user_id","authorization_commitment","issued_at") REFERENCES "public"."integration_statuses"("id","integration_id","label","verified_by_user_id","authorization_reference","verified_at") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_channel_change_authorizations" ADD CONSTRAINT "channel_change_authorizations_authorizer_session_fk" FOREIGN KEY ("authorized_with_session_id","authorized_by_user_id") REFERENCES "public"."sessions"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_channel_change_authorizations" ADD CONSTRAINT "channel_change_authorizations_consumer_session_fk" FOREIGN KEY ("consumed_with_session_id","consumed_by_user_id") REFERENCES "public"."sessions"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_changes" ADD CONSTRAINT "user_role_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_changes" ADD CONSTRAINT "user_role_changes_changer_session_fk" FOREIGN KEY ("changed_with_session_id","changed_by_user_id") REFERENCES "public"."sessions"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_change_authorizations_integration_idx" ON "integration_channel_change_authorizations" USING btree ("integration_id","consumed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_role_changes_effective_idx" ON "user_role_changes" USING btree ("user_id","role","sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_role_changes_changer_idx" ON "user_role_changes" USING btree ("changed_by_user_id","sequence" DESC NULLS LAST);--> statement-breakpoint

-- A stricter append guard must not silently legitimize an ambiguous existing
-- graph. Abort the whole transaction so operators can correct the legacy data
-- explicitly before retrying the forward migration.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM public."roster_source_configurations"
		GROUP BY "population"
		HAVING pg_catalog.count(DISTINCT "id") > 1
	) THEN
		RAISE EXCEPTION 'Roster source configurations contain multiple lineages for one population'
			USING ERRCODE = '55000';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM (
			SELECT
				"version",
				pg_catalog.row_number() OVER (
					PARTITION BY "population", "id"
					ORDER BY "version"
				) AS expected_version
			FROM public."roster_source_configurations"
		) AS ordered_versions
		WHERE "version" <> expected_version
	) THEN
		RAISE EXCEPTION 'Roster source configuration versions are not contiguous from one'
			USING ERRCODE = '55000';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM (
			SELECT
				"version",
				pg_catalog.min("version") OVER (
					PARTITION BY "population"
				) AS initial_version,
				pg_catalog.row_number() OVER (
					PARTITION BY "population"
					ORDER BY "version"
				) AS expected_version
			FROM public."roster_snapshots"
		) AS ordered_versions
		WHERE "version" <> initial_version + expected_version - 1
	) THEN
		RAISE EXCEPTION 'Roster snapshot versions are not contiguous'
			USING ERRCODE = '55000';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM public."audience_configurations"
		GROUP BY "facility_id"
		HAVING pg_catalog.count(DISTINCT "id") > 1
	) THEN
		RAISE EXCEPTION 'Audience configurations contain multiple lineages for one facility'
			USING ERRCODE = '55000';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM public."audience_configurations"
		GROUP BY "id"
		HAVING pg_catalog.count(DISTINCT "facility_id") > 1
	) THEN
		RAISE EXCEPTION 'Audience configuration lineage cannot span facilities'
			USING ERRCODE = '55000';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM (
			SELECT
				"version",
				pg_catalog.row_number() OVER (
					PARTITION BY "id"
					ORDER BY "version"
				) AS expected_version
			FROM public."audience_configurations"
		) AS ordered_versions
		WHERE "version" <> expected_version
	) THEN
		RAISE EXCEPTION 'Audience configuration versions are not contiguous from one'
			USING ERRCODE = '55000';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM (
			SELECT
				"version",
				pg_catalog.row_number() OVER (
					PARTITION BY "id"
					ORDER BY "version"
				) AS expected_version
			FROM public."neighborhood_versions"
		) AS ordered_versions
		WHERE "version" <> expected_version
	) THEN
		RAISE EXCEPTION 'Neighborhood versions are not contiguous from one'
			USING ERRCODE = '55000';
	END IF;
END;
$$;--> statement-breakpoint

-- Any newly observed status requires a fresh human decision. During upgrade,
-- pin every existing channel to the deterministic latest observation and
-- disable it without changing one byte of append-only status history.
WITH latest_status AS (
	SELECT DISTINCT ON ("integration_id")
		"id",
		"integration_id",
		"label",
		"observed_at"
	FROM public."integration_statuses"
	ORDER BY "integration_id", "observed_at" DESC, "id" DESC
)
UPDATE public."channel_configurations" AS configuration
SET
	"enabled" = false,
	"status_id" = latest_status."id",
	"status_label" = latest_status."label",
	"changed_at" = GREATEST(
		configuration."changed_at",
		latest_status."observed_at",
		pg_catalog.statement_timestamp()
	)
FROM latest_status
WHERE latest_status."integration_id" = configuration."integration_id";--> statement-breakpoint

DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM public."channel_configurations" AS configuration
		LEFT JOIN LATERAL (
			SELECT status."id", status."label"
			FROM public."integration_statuses" AS status
			WHERE status."integration_id" = configuration."integration_id"
			ORDER BY status."observed_at" DESC, status."id" DESC
			LIMIT 1
		) AS latest_status ON true
		WHERE configuration."enabled"
			OR latest_status."id" IS NULL
			OR configuration."status_id" IS DISTINCT FROM latest_status."id"
			OR configuration."status_label" IS DISTINCT FROM latest_status."label"
	) THEN
		RAISE EXCEPTION 'Channel configuration reconciliation did not fail closed'
			USING ERRCODE = '55000';
	END IF;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public."psd_eoc_guard_integration_status_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	existing_row jsonb;
	latest_observed_at timestamp with time zone;
BEGIN
	IF TG_RELID <> 'public.integration_statuses'::pg_catalog.regclass
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME <> 'integration_statuses'
		OR TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'INSERT'
	THEN
		RAISE EXCEPTION 'Unexpected integration-status trigger context'
			USING ERRCODE = '55000';
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(NEW."integration_id", 0)
	);

	SELECT pg_catalog.to_jsonb(existing)
	INTO existing_row
	FROM public."integration_statuses" AS existing
	WHERE existing."id" = NEW."id";

	IF FOUND THEN
		IF existing_row IS NOT DISTINCT FROM pg_catalog.to_jsonb(NEW) THEN
			RETURN NEW;
		END IF;
		RAISE EXCEPTION 'Integration-status retry does not match immutable history'
			USING ERRCODE = '55000';
	END IF;

	IF NEW."verified_at" IS NOT NULL
		AND NEW."verified_at" IS DISTINCT FROM
			pg_catalog.date_trunc('milliseconds', NEW."verified_at")
	THEN
		RAISE EXCEPTION 'Live verification time must use millisecond precision'
			USING ERRCODE = '55000';
	END IF;

	SELECT status."observed_at"
	INTO latest_observed_at
	FROM public."integration_statuses" AS status
	WHERE status."integration_id" = NEW."integration_id"
	ORDER BY status."observed_at" DESC, status."id" DESC
	LIMIT 1;

	IF latest_observed_at IS NOT NULL
		AND NEW."observed_at" <= latest_observed_at
	THEN
		RAISE EXCEPTION 'Integration status observation must advance beyond %', latest_observed_at
			USING ERRCODE = '55000';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public."psd_eoc_sync_channel_configuration_after_status"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	IF TG_RELID <> 'public.integration_statuses'::pg_catalog.regclass
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME <> 'integration_statuses'
		OR TG_WHEN <> 'AFTER'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'INSERT'
	THEN
		RAISE EXCEPTION 'Unexpected channel-configuration synchronization context'
			USING ERRCODE = '55000';
	END IF;

	UPDATE public."channel_configurations" AS configuration
	SET
		"enabled" = false,
		"status_id" = NEW."id",
		"status_label" = NEW."label",
		"changed_at" = GREATEST(
			configuration."changed_at",
			NEW."observed_at",
			pg_catalog.statement_timestamp()
		)
	WHERE configuration."integration_id" = NEW."integration_id";

	RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public."psd_eoc_guard_user_role_change_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	issued_sequence bigint;
BEGIN
	IF TG_RELID <> 'public.user_role_changes'::pg_catalog.regclass
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME <> 'user_role_changes'
		OR TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'INSERT'
	THEN
		RAISE EXCEPTION 'Unexpected role-change sequence trigger context'
			USING ERRCODE = '55000';
	END IF;

	BEGIN
		issued_sequence := pg_catalog.currval(
			'public.user_role_changes_sequence_seq'::pg_catalog.regclass
		);
	EXCEPTION
		WHEN object_not_in_prerequisite_state THEN
			RAISE EXCEPTION 'Role-change sequence must be database-issued'
				USING ERRCODE = '55000';
	END;

	IF NEW."sequence" IS DISTINCT FROM issued_sequence THEN
		RAISE EXCEPTION 'Role-change sequence must be the database-issued value'
			USING ERRCODE = '55000';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public."psd_eoc_guard_roster_source_configuration_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	existing_row jsonb;
	latest_id uuid;
	latest_version integer;
BEGIN
	IF TG_RELID <> 'public.roster_source_configurations'::pg_catalog.regclass
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME <> 'roster_source_configurations'
		OR TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'INSERT'
	THEN
		RAISE EXCEPTION 'Unexpected roster-source configuration trigger context'
			USING ERRCODE = '55000';
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			'psd-eoc-roster-' || NEW."population"::pg_catalog.text,
			0
		)
	);

	SELECT pg_catalog.to_jsonb(existing)
	INTO existing_row
	FROM public."roster_source_configurations" AS existing
	WHERE existing."id" = NEW."id"
		AND existing."version" = NEW."version";

	IF FOUND THEN
		IF existing_row IS NOT DISTINCT FROM pg_catalog.to_jsonb(NEW) THEN
			RETURN NEW;
		END IF;
		RAISE EXCEPTION 'Roster-source configuration retry does not match immutable history'
			USING ERRCODE = '55000';
	END IF;

	SELECT configuration."id", configuration."version"
	INTO latest_id, latest_version
	FROM public."roster_source_configurations" AS configuration
	WHERE configuration."population" = NEW."population"
	ORDER BY configuration."version" DESC
	LIMIT 1;

	IF latest_version IS NULL THEN
		IF NEW."version" <> 1 THEN
			RAISE EXCEPTION 'First roster-source configuration version must be one'
				USING ERRCODE = '55000';
		END IF;
		RETURN NEW;
	END IF;

	IF NEW."id" IS DISTINCT FROM latest_id THEN
		RAISE EXCEPTION 'Roster-source configuration lineage cannot change for population %', NEW."population"
			USING ERRCODE = '55000';
	END IF;
	IF NEW."version" <> latest_version + 1 THEN
		RAISE EXCEPTION 'Roster-source configuration version must advance exactly once beyond %', latest_version
			USING ERRCODE = '55000';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public."psd_eoc_guard_roster_snapshot_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	existing_row jsonb;
	latest_version integer;
	current_configuration_id uuid;
	current_configuration_version integer;
BEGIN
	IF TG_RELID <> 'public.roster_snapshots'::pg_catalog.regclass
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME <> 'roster_snapshots'
		OR TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'INSERT'
	THEN
		RAISE EXCEPTION 'Unexpected roster-snapshot trigger context'
			USING ERRCODE = '55000';
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			'psd-eoc-roster-' || NEW."population"::pg_catalog.text,
			0
		)
	);

	SELECT pg_catalog.to_jsonb(existing)
	INTO existing_row
	FROM public."roster_snapshots" AS existing
	WHERE existing."id" = NEW."id";

	IF FOUND THEN
		IF existing_row IS NOT DISTINCT FROM pg_catalog.to_jsonb(NEW) THEN
			RETURN NEW;
		END IF;
		RAISE EXCEPTION 'Roster snapshot retry does not match immutable history'
			USING ERRCODE = '55000';
	END IF;

	SELECT configuration."id", configuration."version"
	INTO current_configuration_id, current_configuration_version
	FROM public."roster_source_configurations" AS configuration
	WHERE configuration."population" = NEW."population"
	ORDER BY configuration."version" DESC
	LIMIT 1;

	IF current_configuration_id IS NULL THEN
		RAISE EXCEPTION 'Roster snapshot requires a current source configuration for population %', NEW."population"
			USING ERRCODE = '55000';
	END IF;
	IF NEW."source_configuration_id" IS DISTINCT FROM current_configuration_id
		OR NEW."source_configuration_version" IS DISTINCT FROM current_configuration_version
	THEN
		RAISE EXCEPTION 'Roster snapshot must pin the current source configuration for population %', NEW."population"
			USING ERRCODE = '55000';
	END IF;

	SELECT snapshot."version"
	INTO latest_version
	FROM public."roster_snapshots" AS snapshot
	WHERE snapshot."population" = NEW."population"
	ORDER BY snapshot."version" DESC
	LIMIT 1;

	IF latest_version IS NOT NULL
		AND NEW."version" <> latest_version + 1
	THEN
		RAISE EXCEPTION 'Roster snapshot version must advance beyond % by exactly one', latest_version
			USING ERRCODE = '55000';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public."psd_eoc_guard_roster_configuration_child_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	new_row jsonb;
	existing_row jsonb;
	parent_created_in_current_transaction boolean := false;
BEGIN
	IF TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'INSERT'
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME NOT IN (
			'roster_source_configuration_facilities',
			'roster_source_configuration_groups'
		)
	THEN
		RAISE EXCEPTION 'Unexpected roster-configuration child trigger context'
			USING ERRCODE = '55000';
	END IF;

	new_row := pg_catalog.to_jsonb(NEW);

	CASE TG_TABLE_NAME
		WHEN 'roster_source_configuration_facilities' THEN
			SELECT pg_catalog.to_jsonb(existing)
			INTO existing_row
			FROM public."roster_source_configuration_facilities" AS existing
			WHERE existing."configuration_id" = NEW."configuration_id"
				AND existing."configuration_version" = NEW."configuration_version"
				AND existing."facility_id" =
					(new_row ->> 'facility_id')::pg_catalog.uuid;
		WHEN 'roster_source_configuration_groups' THEN
			SELECT pg_catalog.to_jsonb(existing)
			INTO existing_row
			FROM public."roster_source_configuration_groups" AS existing
			WHERE existing."configuration_id" = NEW."configuration_id"
				AND existing."configuration_version" = NEW."configuration_version"
				AND existing."group_source_id" =
					(new_row ->> 'group_source_id')::pg_catalog.uuid;
	END CASE;

	IF FOUND THEN
		IF existing_row IS NOT DISTINCT FROM new_row THEN
			RETURN NEW;
		END IF;
		RAISE EXCEPTION 'Roster-configuration child retry does not match immutable history'
			USING ERRCODE = '55000';
	END IF;

	SELECT parent.xmin =
		pg_catalog.pg_current_xact_id()::pg_catalog.xid
	INTO parent_created_in_current_transaction
	FROM public."roster_source_configurations" AS parent
	WHERE parent."id" = NEW."configuration_id"
		AND parent."version" = NEW."configuration_version";

	IF parent_created_in_current_transaction IS TRUE THEN
		RETURN NEW;
	END IF;

	RAISE EXCEPTION 'Published roster source configuration cannot accept new % rows', TG_TABLE_NAME
		USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public."psd_eoc_guard_roster_snapshot_child_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	new_row jsonb;
	existing_row jsonb;
	parent_created_in_current_transaction boolean := false;
BEGIN
	IF TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'INSERT'
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME NOT IN (
			'roster_snapshot_facilities',
			'roster_snapshot_sources',
			'roster_recipients',
			'roster_recipient_group_sources',
			'roster_endpoints'
		)
	THEN
		RAISE EXCEPTION 'Unexpected roster-snapshot child trigger context'
			USING ERRCODE = '55000';
	END IF;

	new_row := pg_catalog.to_jsonb(NEW);

	CASE TG_TABLE_NAME
		WHEN 'roster_snapshot_facilities' THEN
			SELECT pg_catalog.to_jsonb(existing)
			INTO existing_row
			FROM public."roster_snapshot_facilities" AS existing
			WHERE existing."roster_snapshot_id" = NEW."roster_snapshot_id"
				AND existing."facility_id" =
					(new_row ->> 'facility_id')::pg_catalog.uuid;
		WHEN 'roster_snapshot_sources' THEN
			SELECT pg_catalog.to_jsonb(existing)
			INTO existing_row
			FROM public."roster_snapshot_sources" AS existing
			WHERE existing."roster_snapshot_id" = NEW."roster_snapshot_id"
				AND existing."group_source_id" =
					(new_row ->> 'group_source_id')::pg_catalog.uuid
				AND existing."completion_kind"::pg_catalog.text =
					new_row ->> 'completion_kind';
		WHEN 'roster_recipients' THEN
			SELECT pg_catalog.to_jsonb(existing)
			INTO existing_row
			FROM public."roster_recipients" AS existing
			WHERE existing."roster_snapshot_id" = NEW."roster_snapshot_id"
				AND existing."id" = (new_row ->> 'id')::pg_catalog.uuid;
		WHEN 'roster_recipient_group_sources' THEN
			SELECT pg_catalog.to_jsonb(existing)
			INTO existing_row
			FROM public."roster_recipient_group_sources" AS existing
			WHERE existing."roster_snapshot_id" = NEW."roster_snapshot_id"
				AND existing."recipient_id" =
					(new_row ->> 'recipient_id')::pg_catalog.uuid
				AND existing."group_source_id" =
					(new_row ->> 'group_source_id')::pg_catalog.uuid;
		WHEN 'roster_endpoints' THEN
			SELECT pg_catalog.to_jsonb(existing)
			INTO existing_row
			FROM public."roster_endpoints" AS existing
			WHERE existing."roster_snapshot_id" = NEW."roster_snapshot_id"
				AND existing."id" = (new_row ->> 'id')::pg_catalog.uuid;
	END CASE;

	IF FOUND THEN
		IF existing_row IS NOT DISTINCT FROM new_row THEN
			RETURN NEW;
		END IF;
		RAISE EXCEPTION 'Roster-snapshot child retry does not match immutable history'
			USING ERRCODE = '55000';
	END IF;

	SELECT parent.xmin =
		pg_catalog.pg_current_xact_id()::pg_catalog.xid
	INTO parent_created_in_current_transaction
	FROM public."roster_snapshots" AS parent
	WHERE parent."id" = NEW."roster_snapshot_id";

	IF parent_created_in_current_transaction IS TRUE THEN
		RETURN NEW;
	END IF;

	RAISE EXCEPTION 'Published roster snapshot cannot accept new % rows', TG_TABLE_NAME
		USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public."psd_eoc_guard_admin_version_parent_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	new_row jsonb;
	existing_row jsonb;
	latest_id uuid;
	latest_version integer;
BEGIN
	IF TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'INSERT'
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME NOT IN (
			'neighborhood_versions',
			'audience_configurations'
		)
	THEN
		RAISE EXCEPTION 'Unexpected admin version parent trigger context'
			USING ERRCODE = '55000';
	END IF;

	new_row := pg_catalog.to_jsonb(NEW);

	CASE TG_TABLE_NAME
		WHEN 'neighborhood_versions' THEN
			PERFORM pg_catalog.pg_advisory_xact_lock(
				pg_catalog.hashtextextended(
					'admin-neighborhood-version:' || NEW."id"::pg_catalog.text,
					0
				)
			);
			SELECT pg_catalog.to_jsonb(existing)
			INTO existing_row
			FROM public."neighborhood_versions" AS existing
			WHERE existing."id" = NEW."id"
				AND existing."version" = NEW."version";
		WHEN 'audience_configurations' THEN
			PERFORM 1
			FROM public."facilities" AS facility
			WHERE facility."id" = NEW."facility_id"
			FOR UPDATE;
			IF NOT FOUND THEN
				RAISE EXCEPTION 'Audience configuration facility does not exist'
					USING ERRCODE = '55000';
			END IF;
			SELECT pg_catalog.to_jsonb(existing)
			INTO existing_row
			FROM public."audience_configurations" AS existing
			WHERE existing."id" = NEW."id"
				AND existing."version" = NEW."version";
	END CASE;

	IF FOUND THEN
		IF existing_row IS NOT DISTINCT FROM new_row THEN
			RETURN NEW;
		END IF;
		RAISE EXCEPTION 'Admin version retry does not match immutable history'
			USING ERRCODE = '55000';
	END IF;

	CASE TG_TABLE_NAME
		WHEN 'neighborhood_versions' THEN
			SELECT version."id", version."version"
			INTO latest_id, latest_version
			FROM public."neighborhood_versions" AS version
			WHERE version."id" = NEW."id"
			ORDER BY version."version" DESC
			LIMIT 1;
		WHEN 'audience_configurations' THEN
			SELECT configuration."id", configuration."version"
			INTO latest_id, latest_version
			FROM public."audience_configurations" AS configuration
			WHERE configuration."facility_id" = NEW."facility_id"
			ORDER BY configuration."version" DESC
			LIMIT 1;
	END CASE;

	IF latest_version IS NULL THEN
		IF NEW."version" <> 1 THEN
			RAISE EXCEPTION 'First admin version must be one'
				USING ERRCODE = '55000';
		END IF;
		RETURN NEW;
	END IF;

	IF NEW."id" IS DISTINCT FROM latest_id THEN
		RAISE EXCEPTION 'Admin version lineage cannot change'
			USING ERRCODE = '55000';
	END IF;
	IF NEW."version" <> latest_version + 1 THEN
		RAISE EXCEPTION 'Admin version must advance exactly once beyond %', latest_version
			USING ERRCODE = '55000';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public."psd_eoc_guard_admin_version_child_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	new_row jsonb;
	existing_row jsonb;
	parent_created_in_current_transaction boolean := false;
BEGIN
	IF TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'INSERT'
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME NOT IN (
			'audience_targets',
			'neighborhood_facilities'
		)
	THEN
		RAISE EXCEPTION 'Unexpected admin version construction trigger context'
			USING ERRCODE = '55000';
	END IF;

	new_row := pg_catalog.to_jsonb(NEW);

	CASE TG_TABLE_NAME
		WHEN 'audience_targets' THEN
			SELECT pg_catalog.to_jsonb(existing)
			INTO existing_row
			FROM public."audience_targets" AS existing
			WHERE existing."audience_config_id" =
					(new_row ->> 'audience_config_id')::pg_catalog.uuid
				AND existing."audience_config_version" =
					(new_row ->> 'audience_config_version')::pg_catalog.int4
				AND existing."ordinal" =
					(new_row ->> 'ordinal')::pg_catalog.int4;
		WHEN 'neighborhood_facilities' THEN
			SELECT pg_catalog.to_jsonb(existing)
			INTO existing_row
			FROM public."neighborhood_facilities" AS existing
			WHERE existing."neighborhood_id" =
					(new_row ->> 'neighborhood_id')::pg_catalog.uuid
				AND existing."neighborhood_version" =
					(new_row ->> 'neighborhood_version')::pg_catalog.int4
				AND existing."facility_id" =
					(new_row ->> 'facility_id')::pg_catalog.uuid;
	END CASE;

	IF FOUND THEN
		IF existing_row IS NOT DISTINCT FROM new_row THEN
			RETURN NEW;
		END IF;
		RAISE EXCEPTION 'Admin version child retry does not match immutable history'
			USING ERRCODE = '55000';
	END IF;

	CASE TG_TABLE_NAME
		WHEN 'audience_targets' THEN
			SELECT parent.xmin =
				pg_catalog.pg_current_xact_id()::pg_catalog.xid
			INTO parent_created_in_current_transaction
			FROM public."audience_configurations" AS parent
			WHERE parent."id" =
					(new_row ->> 'audience_config_id')::pg_catalog.uuid
				AND parent."version" =
					(new_row ->> 'audience_config_version')::pg_catalog.int4;
		WHEN 'neighborhood_facilities' THEN
			SELECT parent.xmin =
				pg_catalog.pg_current_xact_id()::pg_catalog.xid
			INTO parent_created_in_current_transaction
			FROM public."neighborhood_versions" AS parent
			WHERE parent."id" =
					(new_row ->> 'neighborhood_id')::pg_catalog.uuid
				AND parent."version" =
					(new_row ->> 'neighborhood_version')::pg_catalog.int4;
	END CASE;

	IF parent_created_in_current_transaction IS TRUE THEN
		RETURN NEW;
	END IF;

	RAISE EXCEPTION 'Published version cannot accept new % rows', TG_TABLE_NAME
		USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "integration_statuses_monotonic_insert_guard"
BEFORE INSERT ON public."integration_statuses"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_guard_integration_status_insert"();--> statement-breakpoint

CREATE TRIGGER "integration_statuses_channel_configuration_sync"
AFTER INSERT ON public."integration_statuses"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_sync_channel_configuration_after_status"();--> statement-breakpoint

CREATE TRIGGER "user_role_changes_sequence_guard"
BEFORE INSERT ON public."user_role_changes"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_guard_user_role_change_insert"();--> statement-breakpoint

CREATE TRIGGER "roster_source_configurations_monotonic_insert_guard"
BEFORE INSERT ON public."roster_source_configurations"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_guard_roster_source_configuration_insert"();--> statement-breakpoint

CREATE TRIGGER "neighborhood_versions_monotonic_insert_guard"
BEFORE INSERT ON public."neighborhood_versions"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_guard_admin_version_parent_insert"();--> statement-breakpoint

CREATE TRIGGER "audience_configurations_monotonic_insert_guard"
BEFORE INSERT ON public."audience_configurations"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_guard_admin_version_parent_insert"();--> statement-breakpoint

CREATE TRIGGER "audience_targets_construction_guard"
BEFORE INSERT ON public."audience_targets"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_guard_admin_version_child_insert"();--> statement-breakpoint

CREATE TRIGGER "neighborhood_facilities_construction_guard"
BEFORE INSERT ON public."neighborhood_facilities"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_guard_admin_version_child_insert"();--> statement-breakpoint

CREATE TRIGGER "user_role_changes_immutable_guard"
BEFORE UPDATE ON public."user_role_changes"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();--> statement-breakpoint

CREATE TRIGGER "user_role_changes_retain_guard"
BEFORE DELETE ON public."user_role_changes"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_reject_delete"();--> statement-breakpoint

CREATE TRIGGER "integration_channel_change_authorizations_immutable_guard"
BEFORE UPDATE ON public."integration_channel_change_authorizations"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();--> statement-breakpoint

CREATE TRIGGER "integration_channel_change_authorizations_retain_guard"
BEFORE DELETE ON public."integration_channel_change_authorizations"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_reject_delete"();--> statement-breakpoint

CREATE TRIGGER "user_roles_immutable_guard"
BEFORE UPDATE ON public."user_roles"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();--> statement-breakpoint

CREATE TRIGGER "neighborhood_versions_immutable_guard"
BEFORE UPDATE ON public."neighborhood_versions"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();--> statement-breakpoint

CREATE TRIGGER "neighborhood_facilities_immutable_guard"
BEFORE UPDATE ON public."neighborhood_facilities"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();--> statement-breakpoint

CREATE TRIGGER "audience_configurations_immutable_guard"
BEFORE UPDATE ON public."audience_configurations"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();--> statement-breakpoint

CREATE TRIGGER "audience_targets_immutable_guard"
BEFORE UPDATE ON public."audience_targets"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();--> statement-breakpoint

REVOKE ALL ON FUNCTION public."psd_eoc_guard_integration_status_insert"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_sync_channel_configuration_after_status"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_guard_user_role_change_insert"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_guard_roster_source_configuration_insert"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_guard_roster_snapshot_insert"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_guard_roster_configuration_child_insert"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_guard_roster_snapshot_child_insert"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_guard_admin_version_parent_insert"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_guard_admin_version_child_insert"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_reject_immutable_mutation"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_reject_delete"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint

REVOKE ALL PRIVILEGES ON TABLE
	public."user_role_changes",
	public."integration_channel_change_authorizations"
FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE
	public."user_role_changes",
	public."integration_channel_change_authorizations"
TO "psd_eoc_app";--> statement-breakpoint

REVOKE ALL PRIVILEGES ON SEQUENCE
	public."user_role_changes_sequence_seq"
FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE
	public."user_role_changes_sequence_seq"
TO "psd_eoc_app";--> statement-breakpoint
REVOKE UPDATE ON SEQUENCE
	public."user_role_changes_sequence_seq"
FROM "psd_eoc_app";--> statement-breakpoint

REVOKE INSERT, UPDATE, DELETE ON TABLE
	public."user_roles"
FROM "psd_eoc_app";--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE
	public."integration_statuses",
	public."audience_configurations",
	public."audience_targets",
	public."neighborhood_versions",
	public."neighborhood_facilities"
FROM "psd_eoc_app";--> statement-breakpoint
