CREATE TYPE "public"."delivery_test_report_status" AS ENUM('succeeded', 'failed', 'incomplete');--> statement-breakpoint
ALTER TYPE "public"."agent_capability_grant" ADD VALUE 'list-delivery-test-reports' BEFORE 'get-integration-health';--> statement-breakpoint
ALTER TYPE "public"."mutation_capability" ADD VALUE 'create-delivery-test-target-set-version' BEFORE 'prepare-activation';--> statement-breakpoint
ALTER TYPE "public"."mutation_capability" ADD VALUE 'record-delivery-test-canary-eligibility' BEFORE 'create-delivery-test-target-set-version';--> statement-breakpoint
ALTER TYPE "public"."mutation_capability" ADD VALUE 'finalize-delivery-test-report' BEFORE 'register-push-token';--> statement-breakpoint
ALTER TABLE "roster_endpoints" DROP CONSTRAINT "roster_endpoints_synthetic_unroutable";--> statement-breakpoint
ALTER TABLE "roster_endpoints" ADD CONSTRAINT "roster_endpoints_synthetic_unroutable" CHECK ((
        "roster_endpoints"."population" = 'staff'
        and not ("roster_endpoints"."channel" = 'sms' and "roster_endpoints"."phone_number" ~ '^\+999')
      ) or (
        "roster_endpoints"."population" = 'synthetic'
        and (
        ("roster_endpoints"."channel" = 'push' and "roster_endpoints"."token" like 'synthetic-unroutable:%')
        or ("roster_endpoints"."channel" = 'email' and lower("roster_endpoints"."email") like '%.invalid')
        or ("roster_endpoints"."channel" = 'sms' and (
          "roster_endpoints"."phone_number" ~ '^\+120255501[0-9]{2}$'
          or "roster_endpoints"."phone_number" ~ '^\+999[0-9]{12}$'
        ))
        )
      ));--> statement-breakpoint
CREATE TABLE "delivery_test_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"run_started_at" timestamp with time zone NOT NULL,
	"sequence" integer NOT NULL,
	"supersedes_report_id" uuid,
	"status" "delivery_test_report_status" NOT NULL,
	"channels" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_by" jsonb NOT NULL,
	"source" "invocation_source" NOT NULL,
	"reason_code" varchar(100),
	CONSTRAINT "delivery_test_reports_run_sequence_uq" UNIQUE("run_id","sequence"),
	CONSTRAINT "delivery_test_reports_identity_run_uq" UNIQUE("id","run_id"),
	CONSTRAINT "delivery_test_reports_sequence_positive" CHECK ("delivery_test_reports"."sequence" > 0),
	CONSTRAINT "delivery_test_reports_sequence_chain" CHECK (("delivery_test_reports"."sequence" = 1) = ("delivery_test_reports"."supersedes_report_id" is null)),
	CONSTRAINT "delivery_test_reports_not_self_superseding" CHECK ("delivery_test_reports"."supersedes_report_id" is null or "delivery_test_reports"."supersedes_report_id" <> "delivery_test_reports"."id"),
	CONSTRAINT "delivery_test_reports_channels_shape" CHECK (jsonb_typeof("delivery_test_reports"."channels") is not distinct from 'array'
        and jsonb_array_length("delivery_test_reports"."channels") between 2 and 3),
	CONSTRAINT "delivery_test_reports_status_reason_truth" CHECK ((
        "delivery_test_reports"."status" = 'succeeded' and "delivery_test_reports"."reason_code" is null
      ) or (
        "delivery_test_reports"."status" in ('failed', 'incomplete')
        and "delivery_test_reports"."reason_code" is not null
      )),
	CONSTRAINT "delivery_test_reports_reason_code_format" CHECK ("delivery_test_reports"."reason_code" is null or "delivery_test_reports"."reason_code" ~ '^[A-Z0-9_]+$'),
	CONSTRAINT "delivery_test_reports_system_finalizer" CHECK ("delivery_test_reports"."finalized_by" ->> 'kind' is not distinct from 'system'
        and "delivery_test_reports"."source" = 'worker'),
	CONSTRAINT "delivery_test_reports_after_run" CHECK ("delivery_test_reports"."generated_at" >= "delivery_test_reports"."run_started_at")
);
--> statement-breakpoint
CREATE TABLE "delivery_test_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activation_preview_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"notification_intent_id" uuid NOT NULL,
	"target_set_version_id" uuid NOT NULL,
	"target_set_version" integer NOT NULL,
	"endpoint_reference_digest" varchar(64) NOT NULL,
	"consequence_digest" varchar(64) NOT NULL,
	"confirmation_id" uuid NOT NULL,
	"confirmation_status" "human_confirmation_status" DEFAULT 'consumed' NOT NULL,
	"request_id" uuid NOT NULL,
	"started_by_user_id" uuid NOT NULL,
	"started_with_session_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	CONSTRAINT "delivery_test_runs_preview_uq" UNIQUE("activation_preview_id"),
	CONSTRAINT "delivery_test_runs_event_uq" UNIQUE("event_id"),
	CONSTRAINT "delivery_test_runs_intent_uq" UNIQUE("notification_intent_id"),
	CONSTRAINT "delivery_test_runs_confirmation_uq" UNIQUE("confirmation_id"),
	CONSTRAINT "delivery_test_runs_request_uq" UNIQUE("request_id"),
	CONSTRAINT "delivery_test_runs_identity_start_uq" UNIQUE("id","started_at"),
	CONSTRAINT "delivery_test_runs_consumed_confirmation" CHECK ("delivery_test_runs"."confirmation_status" = 'consumed'),
	CONSTRAINT "delivery_test_runs_digest_format" CHECK ("delivery_test_runs"."endpoint_reference_digest" ~ '^[a-f0-9]{64}$'
        and "delivery_test_runs"."consequence_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "delivery_test_canary_eligibility_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supersedes_fact_id" uuid,
	"facility_id" uuid NOT NULL,
	"roster_snapshot_id" uuid NOT NULL,
	"roster_population" "roster_population" DEFAULT 'staff' NOT NULL,
	"recipient_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"decision" varchar(40) NOT NULL,
	"opted_in_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"decided_by_user_id" uuid NOT NULL,
	"decided_with_session_id" uuid NOT NULL,
	"authorization_reference" varchar(255) NOT NULL,
	CONSTRAINT "delivery_test_canary_eligibility_successor_uq" UNIQUE("supersedes_fact_id"),
	CONSTRAINT "delivery_test_canary_eligibility_staff_only" CHECK ("delivery_test_canary_eligibility_facts"."roster_population" = 'staff'),
	CONSTRAINT "delivery_test_canary_eligibility_decision" CHECK ("delivery_test_canary_eligibility_facts"."decision" in ('approved-synthetic-canary', 'revoked')),
	CONSTRAINT "delivery_test_canary_eligibility_revocation_chain" CHECK ("delivery_test_canary_eligibility_facts"."decision" <> 'revoked' or "delivery_test_canary_eligibility_facts"."supersedes_fact_id" is not null),
	CONSTRAINT "delivery_test_canary_eligibility_not_self_superseding" CHECK ("delivery_test_canary_eligibility_facts"."supersedes_fact_id" is null or "delivery_test_canary_eligibility_facts"."supersedes_fact_id" <> "delivery_test_canary_eligibility_facts"."id"),
	CONSTRAINT "delivery_test_canary_eligibility_times" CHECK ("delivery_test_canary_eligibility_facts"."decided_at" >= "delivery_test_canary_eligibility_facts"."opted_in_at"),
	CONSTRAINT "delivery_test_canary_eligibility_reference_format" CHECK ("delivery_test_canary_eligibility_facts"."authorization_reference" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$')
);
--> statement-breakpoint
CREATE TABLE "delivery_test_target_endpoints" (
	"target_set_version_id" uuid NOT NULL,
	"target_set_version" integer NOT NULL,
	"eligibility_fact_id" uuid NOT NULL,
	"roster_snapshot_id" uuid NOT NULL,
	"roster_population" "roster_population" DEFAULT 'staff' NOT NULL,
	"recipient_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"attestation" varchar(40) NOT NULL,
	"opted_in_at" timestamp with time zone NOT NULL,
	"attested_at" timestamp with time zone NOT NULL,
	"attested_by_user_id" uuid NOT NULL,
	"authorization_reference" varchar(255) NOT NULL,
	CONSTRAINT "delivery_test_target_endpoints_target_set_version_id_recipient_id_endpoint_id_channel_pk" PRIMARY KEY("target_set_version_id","recipient_id","endpoint_id","channel"),
	CONSTRAINT "delivery_test_target_endpoints_eligibility_fact_uq" UNIQUE("target_set_version_id","eligibility_fact_id"),
	CONSTRAINT "delivery_test_target_endpoints_attestation_literal" CHECK ("delivery_test_target_endpoints"."attestation" = 'approved-synthetic-canary'),
	CONSTRAINT "delivery_test_target_endpoints_staff_only" CHECK ("delivery_test_target_endpoints"."roster_population" = 'staff'),
	CONSTRAINT "delivery_test_target_endpoints_attestation_after_opt_in" CHECK ("delivery_test_target_endpoints"."attested_at" >= "delivery_test_target_endpoints"."opted_in_at"),
	CONSTRAINT "delivery_test_target_endpoints_reference_format" CHECK ("delivery_test_target_endpoints"."authorization_reference" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$')
);
--> statement-breakpoint
CREATE TABLE "delivery_test_target_set_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"facility_id" uuid NOT NULL,
	"roster_snapshot_id" uuid NOT NULL,
	"roster_population" "roster_population" DEFAULT 'staff' NOT NULL,
	"supersedes_version_id" uuid,
	"endpoint_reference_digest" varchar(64) NOT NULL,
	"idempotency_request_id" uuid NOT NULL,
	"approved_by_user_id" uuid NOT NULL,
	"approved_with_session_id" uuid NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_test_target_sets_identity_version_uq" UNIQUE("id","version"),
	CONSTRAINT "delivery_test_target_sets_roster_anchor_uq" UNIQUE("id","version","roster_snapshot_id"),
	CONSTRAINT "delivery_test_target_sets_request_uq" UNIQUE("idempotency_request_id"),
	CONSTRAINT "delivery_test_target_sets_staff_only" CHECK ("delivery_test_target_set_versions"."roster_population" = 'staff'),
	CONSTRAINT "delivery_test_target_sets_version_positive" CHECK ("delivery_test_target_set_versions"."version" > 0),
	CONSTRAINT "delivery_test_target_sets_version_chain" CHECK (("delivery_test_target_set_versions"."version" = 1) = ("delivery_test_target_set_versions"."supersedes_version_id" is null)),
	CONSTRAINT "delivery_test_target_sets_not_self_superseding" CHECK ("delivery_test_target_set_versions"."supersedes_version_id" is null or "delivery_test_target_set_versions"."supersedes_version_id" <> "delivery_test_target_set_versions"."id"),
	CONSTRAINT "delivery_test_target_sets_digest_format" CHECK ("delivery_test_target_set_versions"."endpoint_reference_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "delivery_test_target_sets_times" CHECK ("delivery_test_target_set_versions"."approved_at" >= "delivery_test_target_set_versions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "activation_previews" ADD COLUMN "delivery_test_target_set_id" uuid;--> statement-breakpoint
ALTER TABLE "activation_previews" ADD COLUMN "delivery_test_target_set_version" integer;--> statement-breakpoint
ALTER TABLE "activation_previews" ADD COLUMN "delivery_test_endpoint_reference_digest" varchar(64);--> statement-breakpoint
ALTER TABLE "notification_intents" ADD COLUMN "delivery_test_target_set_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD COLUMN "delivery_test_target_set_version" integer;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD COLUMN "delivery_test_endpoint_reference_digest" varchar(64);--> statement-breakpoint
-- Referenced composite keys must exist before PostgreSQL can create the run
-- foreign keys below. Drizzle emits these anchors later, so order them here.
ALTER TABLE "activation_previews" ADD CONSTRAINT "activation_previews_delivery_test_anchor_uq" UNIQUE("id","delivery_test_target_set_id","delivery_test_target_set_version","delivery_test_endpoint_reference_digest","consequence_digest");--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_delivery_test_anchor_uq" UNIQUE("id","event_id","request_id","delivery_test_target_set_id","delivery_test_target_set_version","delivery_test_endpoint_reference_digest");--> statement-breakpoint
ALTER TABLE "delivery_test_reports" ADD CONSTRAINT "delivery_test_reports_run_fk" FOREIGN KEY ("run_id","run_started_at") REFERENCES "public"."delivery_test_runs"("id","started_at") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_test_reports" ADD CONSTRAINT "delivery_test_reports_supersedes_same_run_fk" FOREIGN KEY ("supersedes_report_id","run_id") REFERENCES "public"."delivery_test_reports"("id","run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_test_runs" ADD CONSTRAINT "delivery_test_runs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_test_runs" ADD CONSTRAINT "delivery_test_runs_activation_preview_fk" FOREIGN KEY ("activation_preview_id","target_set_version_id","target_set_version","endpoint_reference_digest","consequence_digest") REFERENCES "public"."activation_previews"("id","delivery_test_target_set_id","delivery_test_target_set_version","delivery_test_endpoint_reference_digest","consequence_digest") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_test_runs" ADD CONSTRAINT "delivery_test_runs_notification_intent_fk" FOREIGN KEY ("notification_intent_id","event_id","request_id","target_set_version_id","target_set_version","endpoint_reference_digest") REFERENCES "public"."notification_intents"("id","event_id","request_id","delivery_test_target_set_id","delivery_test_target_set_version","delivery_test_endpoint_reference_digest") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_test_runs" ADD CONSTRAINT "delivery_test_runs_consumed_confirmation_fk" FOREIGN KEY ("confirmation_id","confirmation_status","request_id","consequence_digest") REFERENCES "public"."human_confirmation_records"("id","status","consumed_for_request_id","consequence_digest") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_test_runs" ADD CONSTRAINT "delivery_test_runs_human_session_fk" FOREIGN KEY ("started_with_session_id","started_by_user_id") REFERENCES "public"."sessions"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_test_runs" ADD CONSTRAINT "delivery_test_runs_target_set_fk" FOREIGN KEY ("target_set_version_id","target_set_version") REFERENCES "public"."delivery_test_target_set_versions"("id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_test_canary_eligibility_facts" ADD CONSTRAINT "delivery_test_canary_eligibility_facts_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_test_canary_eligibility_facts" ADD CONSTRAINT "delivery_test_canary_eligibility_snapshot_facility_fk" FOREIGN KEY ("roster_snapshot_id","facility_id") REFERENCES "public"."roster_snapshot_facilities"("roster_snapshot_id","facility_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_test_canary_eligibility_facts" ADD CONSTRAINT "delivery_test_canary_eligibility_roster_endpoint_fk" FOREIGN KEY ("roster_snapshot_id","recipient_id","endpoint_id","roster_population","channel") REFERENCES "public"."roster_endpoints"("roster_snapshot_id","recipient_id","id","population","channel") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_test_canary_eligibility_facts" ADD CONSTRAINT "delivery_test_canary_eligibility_human_session_fk" FOREIGN KEY ("decided_with_session_id","decided_by_user_id") REFERENCES "public"."sessions"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_test_canary_eligibility_facts" ADD CONSTRAINT "delivery_test_canary_eligibility_supersedes_fk" FOREIGN KEY ("supersedes_fact_id") REFERENCES "public"."delivery_test_canary_eligibility_facts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_test_target_endpoints" ADD CONSTRAINT "delivery_test_target_endpoints_eligibility_fact_fk" FOREIGN KEY ("eligibility_fact_id") REFERENCES "public"."delivery_test_canary_eligibility_facts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_test_target_endpoints" ADD CONSTRAINT "delivery_test_target_endpoints_target_set_fk" FOREIGN KEY ("target_set_version_id","target_set_version","roster_snapshot_id") REFERENCES "public"."delivery_test_target_set_versions"("id","version","roster_snapshot_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_test_target_endpoints" ADD CONSTRAINT "delivery_test_target_endpoints_roster_endpoint_fk" FOREIGN KEY ("roster_snapshot_id","recipient_id","endpoint_id","roster_population","channel") REFERENCES "public"."roster_endpoints"("roster_snapshot_id","recipient_id","id","population","channel") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_test_target_set_versions" ADD CONSTRAINT "delivery_test_target_set_versions_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_test_target_set_versions" ADD CONSTRAINT "delivery_test_target_sets_roster_population_fk" FOREIGN KEY ("roster_snapshot_id","roster_population") REFERENCES "public"."roster_snapshots"("id","population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_test_target_set_versions" ADD CONSTRAINT "delivery_test_target_sets_approver_session_fk" FOREIGN KEY ("approved_with_session_id","approved_by_user_id") REFERENCES "public"."sessions"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_test_target_set_versions" ADD CONSTRAINT "delivery_test_target_sets_supersedes_fk" FOREIGN KEY ("supersedes_version_id") REFERENCES "public"."delivery_test_target_set_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_test_reports_generated_at_idx" ON "delivery_test_reports" USING btree ("generated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "delivery_test_runs_started_at_idx" ON "delivery_test_runs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "delivery_test_canary_eligibility_endpoint_idx" ON "delivery_test_canary_eligibility_facts" USING btree ("facility_id","roster_snapshot_id","recipient_id","endpoint_id","channel","decided_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "delivery_test_target_endpoints_channel_idx" ON "delivery_test_target_endpoints" USING btree ("target_set_version_id","channel");--> statement-breakpoint
CREATE INDEX "delivery_test_target_sets_facility_version_idx" ON "delivery_test_target_set_versions" USING btree ("facility_id","version" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "activation_previews" ADD CONSTRAINT "activation_previews_delivery_test_target_set_fk" FOREIGN KEY ("delivery_test_target_set_id","delivery_test_target_set_version","roster_snapshot_id") REFERENCES "public"."delivery_test_target_set_versions"("id","version","roster_snapshot_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_delivery_test_target_set_fk" FOREIGN KEY ("delivery_test_target_set_id","delivery_test_target_set_version","roster_snapshot_id") REFERENCES "public"."delivery_test_target_set_versions"("id","version","roster_snapshot_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activation_previews" ADD CONSTRAINT "activation_previews_delivery_test_truth" CHECK ((
        "activation_previews"."delivery_test_target_set_id" is null
        and "activation_previews"."delivery_test_target_set_version" is null
        and "activation_previews"."delivery_test_endpoint_reference_digest" is null
      ) or (
        "activation_previews"."delivery_test_target_set_id" is not null
        and "activation_previews"."delivery_test_target_set_version" is not null
        and "activation_previews"."delivery_test_endpoint_reference_digest" is not null
        and "activation_previews"."kind" = 'drill'
        and "activation_previews"."template_mode" = 'drill'
        and "activation_previews"."roster_population" = 'staff'
      ));--> statement-breakpoint
ALTER TABLE "activation_previews" ADD CONSTRAINT "activation_previews_delivery_test_digest_format" CHECK ("activation_previews"."delivery_test_endpoint_reference_digest" is null
        or "activation_previews"."delivery_test_endpoint_reference_digest" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_delivery_test_truth" CHECK ((
        "notification_intents"."delivery_test_target_set_id" is null
        and "notification_intents"."delivery_test_target_set_version" is null
        and "notification_intents"."delivery_test_endpoint_reference_digest" is null
      ) or (
        "notification_intents"."delivery_test_target_set_id" is not null
        and "notification_intents"."delivery_test_target_set_version" is not null
        and "notification_intents"."delivery_test_endpoint_reference_digest" is not null
        and "notification_intents"."event_kind" = 'drill'
        and "notification_intents"."template_mode" = 'drill'
        and "notification_intents"."roster_population" = 'staff'
        and "notification_intents"."purpose" = 'activation'
        and "notification_intents"."created_by" ->> 'kind' is not distinct from 'human'
        and "notification_intents"."source" in ('web', 'mobile')
        and "notification_intents"."authorization" ->> 'kind' is not distinct from 'human-confirmed'
      ));--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_delivery_test_digest_format" CHECK ("notification_intents"."delivery_test_endpoint_reference_digest" is null
        or "notification_intents"."delivery_test_endpoint_reference_digest" ~ '^[a-f0-9]{64}$');--> statement-breakpoint

-- Canary eligibility is independent, append-only evidence. A successor must
-- advance the one serialized endpoint chain and preserve its opaque identity.
CREATE OR REPLACE FUNCTION public."psd_eoc_guard_delivery_test_canary_eligibility_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	predecessor public."delivery_test_canary_eligibility_facts"%ROWTYPE;
BEGIN
	IF TG_RELID <> 'public.delivery_test_canary_eligibility_facts'::pg_catalog.regclass
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME <> 'delivery_test_canary_eligibility_facts'
		OR TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'INSERT'
	THEN
		RAISE EXCEPTION 'Unexpected delivery-test canary eligibility trigger context'
			USING ERRCODE = '55000';
	END IF;

	-- Serialize eligibility mutation with target approval, preview, and event
	-- start before taking the narrower endpoint-chain lock. The ordering is
	-- intentional and prevents revocation from racing outbox creation.
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			'delivery-test-target-set:' || NEW."facility_id"::pg_catalog.text,
			30
		)
	);

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			'delivery-test-canary-eligibility:'
			|| NEW."facility_id"::pg_catalog.text || ':'
			|| NEW."roster_snapshot_id"::pg_catalog.text || ':'
			|| NEW."recipient_id"::pg_catalog.text || ':'
			|| NEW."endpoint_id"::pg_catalog.text || ':'
			|| NEW."channel"::pg_catalog.text,
			30
		)
	);

	IF NEW."supersedes_fact_id" IS NULL THEN
		IF NEW."decision" <> 'approved-synthetic-canary' OR EXISTS (
			SELECT 1
			FROM public."delivery_test_canary_eligibility_facts" AS fact
			WHERE fact."facility_id" = NEW."facility_id"
				AND fact."roster_snapshot_id" = NEW."roster_snapshot_id"
				AND fact."recipient_id" = NEW."recipient_id"
				AND fact."endpoint_id" = NEW."endpoint_id"
				AND fact."channel" = NEW."channel"
		) THEN
			RAISE EXCEPTION 'First canary eligibility fact must be one approval for a new endpoint chain'
				USING ERRCODE = '55000';
		END IF;
		RETURN NEW;
	END IF;

	SELECT * INTO predecessor
	FROM public."delivery_test_canary_eligibility_facts" AS fact
	WHERE fact."id" = NEW."supersedes_fact_id";
	IF NOT FOUND
		OR predecessor."facility_id" IS DISTINCT FROM NEW."facility_id"
		OR predecessor."roster_snapshot_id" IS DISTINCT FROM NEW."roster_snapshot_id"
		OR predecessor."recipient_id" IS DISTINCT FROM NEW."recipient_id"
		OR predecessor."endpoint_id" IS DISTINCT FROM NEW."endpoint_id"
		OR predecessor."channel" IS DISTINCT FROM NEW."channel"
		OR predecessor."decision" = NEW."decision"
		OR NEW."decided_at" < predecessor."decided_at"
		OR EXISTS (
			SELECT 1
			FROM public."delivery_test_canary_eligibility_facts" AS successor
			WHERE successor."supersedes_fact_id" = predecessor."id"
		)
	THEN
		RAISE EXCEPTION 'Canary eligibility fact must supersede the latest matching opposite decision'
			USING ERRCODE = '55000';
	END IF;
	IF NEW."decision" = 'revoked'
		AND NEW."opted_in_at" IS DISTINCT FROM predecessor."opted_in_at"
	THEN
		RAISE EXCEPTION 'Canary revocation must retain the approval opt-in timestamp'
			USING ERRCODE = '55000';
	END IF;
	IF NEW."decision" = 'approved-synthetic-canary'
		AND NEW."opted_in_at" < predecessor."decided_at"
	THEN
		RAISE EXCEPTION 'Canary re-approval requires a fresh opt-in after revocation'
			USING ERRCODE = '55000';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

-- A target-set version is one immutable facility lineage. Serialize inserts
-- so concurrent approvals cannot fork or skip a version.
CREATE OR REPLACE FUNCTION public."psd_eoc_guard_delivery_test_target_set_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	latest_id uuid;
	latest_version integer;
BEGIN
	IF TG_RELID <> 'public.delivery_test_target_set_versions'::pg_catalog.regclass
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME <> 'delivery_test_target_set_versions'
		OR TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'INSERT'
	THEN
		RAISE EXCEPTION 'Unexpected delivery-test target-set trigger context'
			USING ERRCODE = '55000';
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			'delivery-test-target-set:' || NEW."facility_id"::pg_catalog.text,
			30
		)
	);

	IF NOT EXISTS (
		SELECT 1
		FROM public."roster_snapshot_facilities" AS snapshot_facility
		WHERE snapshot_facility."roster_snapshot_id" = NEW."roster_snapshot_id"
			AND snapshot_facility."facility_id" = NEW."facility_id"
	) THEN
		RAISE EXCEPTION 'Delivery-test target set must pin a roster snapshot covering its facility'
			USING ERRCODE = '55000';
	END IF;

	SELECT target."id", target."version"
	INTO latest_id, latest_version
	FROM public."delivery_test_target_set_versions" AS target
	WHERE target."facility_id" = NEW."facility_id"
	ORDER BY target."version" DESC, target."created_at" DESC, target."id" DESC
	LIMIT 1;

	IF latest_version IS NULL THEN
		IF NEW."version" <> 1 OR NEW."supersedes_version_id" IS NOT NULL THEN
			RAISE EXCEPTION 'First delivery-test target-set version must be one without a predecessor'
				USING ERRCODE = '55000';
		END IF;
		RETURN NEW;
	END IF;

	IF NEW."version" <> latest_version + 1
		OR NEW."supersedes_version_id" IS DISTINCT FROM latest_id
	THEN
		RAISE EXCEPTION 'Delivery-test target-set version must advance exactly once from the latest facility version'
			USING ERRCODE = '55000';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

-- Endpoint attestations are children of the version created in the same
-- transaction. Once that transaction commits, its membership cannot expand.
CREATE OR REPLACE FUNCTION public."psd_eoc_guard_delivery_test_target_endpoint_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	parent_approved_at timestamp with time zone;
	parent_facility_id uuid;
	parent_created_in_current_transaction boolean := false;
	existing_endpoint_count integer;
	eligibility_fact public."delivery_test_canary_eligibility_facts"%ROWTYPE;
BEGIN
	IF TG_RELID <> 'public.delivery_test_target_endpoints'::pg_catalog.regclass
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME <> 'delivery_test_target_endpoints'
		OR TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'INSERT'
	THEN
		RAISE EXCEPTION 'Unexpected delivery-test target-endpoint trigger context'
			USING ERRCODE = '55000';
	END IF;

	SELECT
		parent."approved_at",
		parent."facility_id",
		parent.xmin = pg_catalog.pg_current_xact_id()::pg_catalog.xid
	INTO parent_approved_at, parent_facility_id, parent_created_in_current_transaction
	FROM public."delivery_test_target_set_versions" AS parent
	WHERE parent."id" = NEW."target_set_version_id"
		AND parent."version" = NEW."target_set_version";

	IF NOT FOUND THEN
		RAISE EXCEPTION 'Delivery-test target endpoint requires its immutable parent version'
			USING ERRCODE = '55000';
	END IF;
	IF parent_created_in_current_transaction IS DISTINCT FROM true THEN
		RAISE EXCEPTION 'Published delivery-test target set cannot accept new endpoints'
			USING ERRCODE = '55000';
	END IF;
	IF NEW."attested_at" > parent_approved_at THEN
		RAISE EXCEPTION 'Delivery-test endpoint attestation cannot postdate target-set approval'
			USING ERRCODE = '55000';
	END IF;

	SELECT * INTO eligibility_fact
	FROM public."delivery_test_canary_eligibility_facts" AS fact
	WHERE fact."id" = NEW."eligibility_fact_id";
	IF NOT FOUND
		OR eligibility_fact."decision" <> 'approved-synthetic-canary'
		OR eligibility_fact."facility_id" IS DISTINCT FROM parent_facility_id
		OR eligibility_fact."roster_snapshot_id" IS DISTINCT FROM NEW."roster_snapshot_id"
		OR eligibility_fact."recipient_id" IS DISTINCT FROM NEW."recipient_id"
		OR eligibility_fact."endpoint_id" IS DISTINCT FROM NEW."endpoint_id"
		OR eligibility_fact."channel" IS DISTINCT FROM NEW."channel"
		OR eligibility_fact."opted_in_at" IS DISTINCT FROM NEW."opted_in_at"
		OR eligibility_fact."decided_at" IS DISTINCT FROM NEW."attested_at"
		OR eligibility_fact."decided_by_user_id" IS DISTINCT FROM NEW."attested_by_user_id"
		OR eligibility_fact."authorization_reference" IS DISTINCT FROM NEW."authorization_reference"
		OR EXISTS (
			SELECT 1
			FROM public."delivery_test_canary_eligibility_facts" AS successor
			WHERE successor."supersedes_fact_id" = eligibility_fact."id"
		)
	THEN
		RAISE EXCEPTION 'Delivery-test target endpoint requires the exact current approved eligibility fact'
			USING ERRCODE = '55000';
	END IF;

	SELECT pg_catalog.count(*)::pg_catalog.int4
	INTO existing_endpoint_count
	FROM public."delivery_test_target_endpoints" AS endpoint
	WHERE endpoint."target_set_version_id" = NEW."target_set_version_id";
	IF existing_endpoint_count >= 12000 THEN
		RAISE EXCEPTION 'Delivery-test target set cannot exceed 12000 endpoints'
			USING ERRCODE = '54000';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

-- Validate the complete child set at commit, after all same-transaction
-- endpoint attestations have been inserted.
CREATE OR REPLACE FUNCTION public."psd_eoc_validate_delivery_test_target_set"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	endpoint_count integer;
	push_count integer;
	email_count integer;
BEGIN
	IF TG_RELID <> 'public.delivery_test_target_set_versions'::pg_catalog.regclass
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME <> 'delivery_test_target_set_versions'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'INSERT'
	THEN
		RAISE EXCEPTION 'Unexpected delivery-test target-set validation context'
			USING ERRCODE = '55000';
	END IF;

	SELECT
		pg_catalog.count(*)::pg_catalog.int4,
		pg_catalog.count(*) FILTER (WHERE endpoint."channel" = 'push')::pg_catalog.int4,
		pg_catalog.count(*) FILTER (WHERE endpoint."channel" = 'email')::pg_catalog.int4
	INTO endpoint_count, push_count, email_count
	FROM public."delivery_test_target_endpoints" AS endpoint
	WHERE endpoint."target_set_version_id" = NEW."id"
		AND endpoint."target_set_version" = NEW."version";

	IF endpoint_count NOT BETWEEN 2 AND 12000
		OR push_count < 1
		OR email_count < 1
	THEN
		RAISE EXCEPTION 'Delivery-test target set requires 2-12000 endpoints including push and email'
			USING ERRCODE = '55000';
	END IF;

	RETURN NULL;
END;
$$;--> statement-breakpoint

-- The opaque digest repeated into previews and notification intents must be
-- the exact digest approved on the target-set version.
CREATE OR REPLACE FUNCTION public."psd_eoc_guard_delivery_test_binding_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	row_json jsonb;
	target_set_id uuid;
	target_set_version integer;
	target_digest text;
	bound_digest text;
BEGIN
	IF TG_TABLE_SCHEMA <> 'public'
		OR TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'INSERT'
		OR TG_TABLE_NAME NOT IN ('activation_previews', 'notification_intents')
	THEN
		RAISE EXCEPTION 'Unexpected delivery-test binding trigger context'
			USING ERRCODE = '55000';
	END IF;

	row_json := pg_catalog.to_jsonb(NEW);
	target_set_id := (row_json ->> 'delivery_test_target_set_id')::pg_catalog.uuid;
	IF target_set_id IS NULL THEN
		RETURN NEW;
	END IF;
	target_set_version :=
		(row_json ->> 'delivery_test_target_set_version')::pg_catalog.int4;
	bound_digest := row_json ->> 'delivery_test_endpoint_reference_digest';

	SELECT target."endpoint_reference_digest"
	INTO target_digest
	FROM public."delivery_test_target_set_versions" AS target
	WHERE target."id" = target_set_id
		AND target."version" = target_set_version;

	IF NOT FOUND OR bound_digest IS DISTINCT FROM target_digest THEN
		RAISE EXCEPTION 'Delivery-test preview or intent must preserve the approved target-set digest'
			USING ERRCODE = '55000';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

-- Monthly live delivery-test previews are human-only consequence previews;
-- they can never enter the agent/human prepared-activation workflow.
CREATE OR REPLACE FUNCTION public."psd_eoc_reject_prepared_delivery_test"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	IF TG_RELID <> 'public.prepared_activations'::pg_catalog.regclass
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME <> 'prepared_activations'
		OR TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'INSERT'
	THEN
		RAISE EXCEPTION 'Unexpected prepared delivery-test trigger context'
			USING ERRCODE = '55000';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM public."activation_previews" AS preview
		WHERE preview."id" = NEW."activation_preview_id"
			AND preview."delivery_test_target_set_id" IS NOT NULL
	) THEN
		RAISE EXCEPTION 'Delivery-test previews cannot be prepared by agents or preparation workflows'
			USING ERRCODE = '55000';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

-- Resolve no destination here. The worker may create an attempt only for the
-- opaque recipient/endpoint/channel tuple present in the pinned approved set.
CREATE OR REPLACE FUNCTION public."psd_eoc_guard_delivery_test_attempt_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	pinned_target_set_id uuid;
	pinned_target_set_version integer;
	target_facility_id uuid;
BEGIN
	IF TG_RELID <> 'public.channel_attempts'::pg_catalog.regclass
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME <> 'channel_attempts'
		OR TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'INSERT'
	THEN
		RAISE EXCEPTION 'Unexpected delivery-test attempt trigger context'
			USING ERRCODE = '55000';
	END IF;

	SELECT
		intent."delivery_test_target_set_id",
		intent."delivery_test_target_set_version",
		target."facility_id"
	INTO pinned_target_set_id, pinned_target_set_version, target_facility_id
	FROM public."notification_intents" AS intent
	LEFT JOIN public."delivery_test_target_set_versions" AS target
		ON target."id" = intent."delivery_test_target_set_id"
		AND target."version" = intent."delivery_test_target_set_version"
	WHERE intent."id" = NEW."intent_id";

	IF NOT FOUND OR pinned_target_set_id IS NULL THEN
		RETURN NEW;
	END IF;
	IF target_facility_id IS NULL THEN
		RAISE EXCEPTION 'Delivery-test attempt target facility is unavailable'
			USING ERRCODE = '55000';
	END IF;

	-- Establish a total order with approval, revocation, preview, and start.
	-- Once this lock is acquired the current eligibility query below observes
	-- every earlier revocation and rejects before attempt truth can be queued.
	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			'delivery-test-target-set:' || target_facility_id::pg_catalog.text,
			30
		)
	);

	IF EXISTS (
		SELECT 1
		FROM public."delivery_test_target_set_versions" AS successor
		WHERE successor."supersedes_version_id" = pinned_target_set_id
	) THEN
		RAISE EXCEPTION 'Delivery-test attempt target set has been superseded'
			USING ERRCODE = '55000';
	END IF;

	IF NOT EXISTS (
		SELECT 1
		FROM public."delivery_test_target_endpoints" AS endpoint
		JOIN public."delivery_test_canary_eligibility_facts" AS fact
			ON fact."id" = endpoint."eligibility_fact_id"
		WHERE endpoint."target_set_version_id" = pinned_target_set_id
			AND endpoint."target_set_version" = pinned_target_set_version
			AND fact."facility_id" = target_facility_id
			AND endpoint."roster_snapshot_id" = NEW."roster_snapshot_id"
			AND endpoint."recipient_id" = NEW."recipient_id"
			AND endpoint."endpoint_id" = NEW."endpoint_id"
			AND endpoint."channel" = NEW."channel"
			AND fact."decision" = 'approved-synthetic-canary'
			AND NOT EXISTS (
				SELECT 1
				FROM public."delivery_test_canary_eligibility_facts" AS successor
				WHERE successor."supersedes_fact_id" = fact."id"
			)
	) THEN
		RAISE EXCEPTION 'Delivery-test attempt endpoint is not in the pinned approved target set'
			USING ERRCODE = '55000';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

-- Validate destination-free report JSON and serialize append-only revisions.
CREATE OR REPLACE FUNCTION public."psd_eoc_guard_delivery_test_report_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	latest_report_id uuid;
	latest_sequence integer;
	latest_generated_at timestamp with time zone;
	channel_row jsonb;
	state_row jsonb;
	channel_name text;
	state_name text;
	endpoint_count numeric;
	latency_is_null boolean;
	completed_is_null boolean;
	state_count numeric;
	counted_endpoints numeric;
	submitted_channels jsonb := '{}'::jsonb;
	submitted_state_counts jsonb;
	expected_channels jsonb;
	expected_status text;
	expected_reason_code text;
	completed_at_value timestamp with time zone;
	latency_value numeric;
	seen_channels text[] := ARRAY[]::text[];
	seen_states text[];
	unknown_count numeric := 0;
	failed_or_expired_count numeric := 0;
	has_non_success_state boolean;
	object_key_count integer;
	pinned_channel_count integer;
	pinned_channel_total integer;
BEGIN
	IF TG_RELID <> 'public.delivery_test_reports'::pg_catalog.regclass
		OR TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME <> 'delivery_test_reports'
		OR TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'INSERT'
	THEN
		RAISE EXCEPTION 'Unexpected delivery-test report trigger context'
			USING ERRCODE = '55000';
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			'psd-eoc-delivery-test-report-' || NEW."run_id"::pg_catalog.text,
			0
		)
	);

	SELECT report."id", report."sequence", report."generated_at"
	INTO latest_report_id, latest_sequence, latest_generated_at
	FROM public."delivery_test_reports" AS report
	WHERE report."run_id" = NEW."run_id"
	ORDER BY report."sequence" DESC
	LIMIT 1;

	IF latest_sequence IS NULL THEN
		IF NEW."sequence" <> 1 OR NEW."supersedes_report_id" IS NOT NULL THEN
			RAISE EXCEPTION 'First delivery-test report must be sequence one without a predecessor'
				USING ERRCODE = '55000';
		END IF;
	ELSIF NEW."sequence" <> latest_sequence + 1
		OR NEW."supersedes_report_id" IS DISTINCT FROM latest_report_id
		OR NEW."generated_at" < latest_generated_at
	THEN
		RAISE EXCEPTION 'Delivery-test report must supersede the latest report with the next sequence'
			USING ERRCODE = '55000';
	END IF;

	IF pg_catalog.jsonb_typeof(NEW."finalized_by") IS DISTINCT FROM 'object'
		OR NEW."finalized_by" ->> 'kind' IS DISTINCT FROM 'system'
		OR coalesce(NEW."finalized_by" ->> 'serviceId', '') !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
		OR NEW."source" IS DISTINCT FROM 'worker'
	THEN
		RAISE EXCEPTION 'Delivery-test report finalizer must be an explicit worker service'
			USING ERRCODE = '55000';
	END IF;
	SELECT pg_catalog.count(*)::pg_catalog.int4
	INTO object_key_count
	FROM pg_catalog.jsonb_object_keys(NEW."finalized_by");
	IF object_key_count <> 2 THEN
		RAISE EXCEPTION 'Delivery-test report finalizer contains unexpected fields'
			USING ERRCODE = '55000';
	END IF;

	-- Recompute the destination-free projection from immutable targets and the
	-- exact latest attempt/evidence rows. This is intentionally independent of
	-- application assembly so direct app-role INSERT cannot fabricate success,
	-- counts, completion timestamps, or provider-accept latency.
	WITH run_context AS MATERIALIZED (
		SELECT
			run."notification_intent_id",
			run."target_set_version_id",
			run."target_set_version",
			run."started_at"
		FROM public."delivery_test_runs" AS run
		WHERE run."id" = NEW."run_id"
	), target_endpoints AS MATERIALIZED (
		SELECT
			endpoint."recipient_id",
			endpoint."endpoint_id",
			endpoint."channel"::pg_catalog.text AS channel,
			run."notification_intent_id",
			run."started_at"
		FROM run_context AS run
		JOIN public."delivery_test_target_endpoints" AS endpoint
			ON endpoint."target_set_version_id" = run."target_set_version_id"
			AND endpoint."target_set_version" = run."target_set_version"
	), latest_attempts AS MATERIALIZED (
		SELECT DISTINCT ON (
			target.channel, target."recipient_id", target."endpoint_id"
		)
			target.channel,
			target."recipient_id",
			target."endpoint_id",
			target."started_at",
			attempt."id" AS attempt_id
		FROM target_endpoints AS target
		LEFT JOIN public."channel_attempts" AS attempt
			ON attempt."intent_id" = target."notification_intent_id"
			AND attempt."recipient_id" = target."recipient_id"
			AND attempt."endpoint_id" = target."endpoint_id"
			AND attempt."channel"::pg_catalog.text = target.channel
		ORDER BY
			target.channel,
			target."recipient_id",
			target."endpoint_id",
			attempt."attempt_number" DESC NULLS LAST,
			attempt."attempted_at" DESC NULLS LAST,
			attempt."id" DESC NULLS LAST
	), endpoint_truth AS MATERIALIZED (
		SELECT
			attempt.channel,
			attempt."started_at",
			CASE
				WHEN latest_evidence.state IS NULL
					OR latest_evidence.state = 'attempted'
				THEN 'unknown'
				ELSE latest_evidence.state
			END AS state,
			accepted_evidence."recorded_at" AS accepted_at
		FROM latest_attempts AS attempt
		LEFT JOIN LATERAL (
			SELECT evidence."state"::pg_catalog.text AS state
			FROM public."delivery_evidence" AS evidence
			WHERE evidence."subject_kind" = 'attempt'
				AND evidence."attempt_id" = attempt.attempt_id
			ORDER BY evidence."sequence" DESC
			LIMIT 1
		) AS latest_evidence ON true
		LEFT JOIN LATERAL (
			SELECT evidence."recorded_at"
			FROM public."delivery_evidence" AS evidence
			WHERE evidence."subject_kind" = 'attempt'
				AND evidence."attempt_id" = attempt.attempt_id
				AND evidence."state" IN ('provider-accepted', 'delivered')
			ORDER BY evidence."sequence"
			LIMIT 1
		) AS accepted_evidence ON true
	), state_truth AS MATERIALIZED (
		SELECT truth.channel, truth.state, pg_catalog.count(*)::pg_catalog.int8 AS state_count
		FROM endpoint_truth AS truth
		GROUP BY truth.channel, truth.state
	), channel_truth AS MATERIALIZED (
		SELECT
			truth.channel,
			pg_catalog.count(*)::pg_catalog.int8 AS endpoint_count,
			pg_catalog.count(truth.accepted_at)::pg_catalog.int8 AS accepted_count,
			pg_catalog.max(truth.accepted_at) AS completed_at,
			pg_catalog.max(truth."started_at") AS started_at
		FROM endpoint_truth AS truth
		GROUP BY truth.channel
	), channel_projection AS MATERIALIZED (
		SELECT
			channel.channel,
			channel.endpoint_count,
			CASE
				WHEN channel.accepted_count = channel.endpoint_count
			THEN pg_catalog.trunc(
					pg_catalog.date_part('epoch', channel.completed_at - channel.started_at) * 1000
				)::pg_catalog.int8
				ELSE NULL
			END AS latency_ms,
			CASE
				WHEN channel.accepted_count = channel.endpoint_count
				THEN channel.completed_at
				ELSE NULL
			END AS completed_at,
			(
				SELECT pg_catalog.jsonb_object_agg(state.state, state.state_count)
				FROM state_truth AS state
				WHERE state.channel = channel.channel
			) AS state_counts
		FROM channel_truth AS channel
	), overall_truth AS MATERIALIZED (
		SELECT
			coalesce(
				pg_catalog.bool_or(truth.state IN ('failed', 'expired')),
				false
			) AS failed,
			coalesce(
				pg_catalog.bool_or(truth.state = 'unknown'),
				false
			) AS uncertain
		FROM endpoint_truth AS truth
	)
	SELECT
		coalesce(
			(
				SELECT pg_catalog.jsonb_object_agg(
					channel.channel,
					pg_catalog.jsonb_build_object(
						'endpointCount', channel.endpoint_count,
						'activationToProviderAcceptMs', channel.latency_ms,
						'latestStateCounts', channel.state_counts,
						'completedAtEpochMs', CASE
							WHEN channel.completed_at IS NULL THEN NULL
							ELSE pg_catalog.trunc(
								pg_catalog.date_part('epoch', channel.completed_at) * 1000
							)::pg_catalog.int8
						END
					)
				)
				FROM channel_projection AS channel
			),
			'{}'::jsonb
		),
		CASE
			WHEN truth.failed THEN 'failed'
			WHEN truth.uncertain THEN 'incomplete'
			ELSE 'succeeded'
		END
	INTO expected_channels, expected_status
	FROM overall_truth AS truth;
	expected_reason_code := CASE expected_status
		WHEN 'failed' THEN 'DELIVERY_TEST_PROVIDER_FAILURE'
		WHEN 'incomplete' THEN 'PROVIDER_TRUTH_PENDING'
		ELSE NULL
	END;

	IF pg_catalog.jsonb_typeof(NEW."channels") IS DISTINCT FROM 'array'
		OR pg_catalog.jsonb_array_length(NEW."channels") NOT BETWEEN 2 AND 3
	THEN
		RAISE EXCEPTION 'Delivery-test report requires two or three channel rows'
			USING ERRCODE = '55000';
	END IF;

	FOR channel_row IN
		SELECT value FROM pg_catalog.jsonb_array_elements(NEW."channels")
	LOOP
		IF pg_catalog.jsonb_typeof(channel_row) IS DISTINCT FROM 'object' THEN
			RAISE EXCEPTION 'Delivery-test channel report must be an object'
				USING ERRCODE = '55000';
		END IF;
		SELECT pg_catalog.count(*)::pg_catalog.int4
		INTO object_key_count
		FROM pg_catalog.jsonb_object_keys(channel_row);
		IF object_key_count <> 5
			OR NOT channel_row ?& ARRAY[
				'channel', 'endpointCount', 'activationToProviderAcceptMs',
				'latestStateCounts', 'completedAt'
			]
		THEN
			RAISE EXCEPTION 'Delivery-test channel report fields must match the contract exactly'
				USING ERRCODE = '55000';
		END IF;

		channel_name := channel_row ->> 'channel';
		IF channel_name NOT IN ('push', 'email', 'sms')
			OR channel_name = ANY(seen_channels)
		THEN
			RAISE EXCEPTION 'Delivery-test report channels must be valid and unique'
				USING ERRCODE = '55000';
		END IF;
		seen_channels := pg_catalog.array_append(seen_channels, channel_name);

		IF pg_catalog.jsonb_typeof(channel_row -> 'endpointCount') IS DISTINCT FROM 'number'
			OR channel_row ->> 'endpointCount' !~ '^(0|[1-9][0-9]*)$'
		THEN
			RAISE EXCEPTION 'Delivery-test endpoint count must be a nonnegative integer'
				USING ERRCODE = '55000';
		END IF;
		endpoint_count := (channel_row ->> 'endpointCount')::pg_catalog.numeric;
		IF endpoint_count NOT BETWEEN 1 AND 12000 THEN
			RAISE EXCEPTION 'Delivery-test endpoint count must be positive and within its safe bound'
				USING ERRCODE = '54000';
		END IF;
		SELECT pg_catalog.count(*)::pg_catalog.int4
		INTO pinned_channel_count
		FROM public."delivery_test_runs" AS run
		JOIN public."delivery_test_target_endpoints" AS endpoint
			ON endpoint."target_set_version_id" = run."target_set_version_id"
			AND endpoint."target_set_version" = run."target_set_version"
		WHERE run."id" = NEW."run_id"
			AND endpoint."channel"::pg_catalog.text = channel_name;
		IF pinned_channel_count = 0 OR endpoint_count <> pinned_channel_count THEN
			RAISE EXCEPTION 'Delivery-test report endpoint count must equal the pinned target channel count'
				USING ERRCODE = '55000';
		END IF;

		latency_is_null :=
			pg_catalog.jsonb_typeof(channel_row -> 'activationToProviderAcceptMs') = 'null';
		IF NOT latency_is_null AND (
			pg_catalog.jsonb_typeof(channel_row -> 'activationToProviderAcceptMs') IS DISTINCT FROM 'number'
			OR channel_row ->> 'activationToProviderAcceptMs' !~ '^(0|[1-9][0-9]*)$'
		) THEN
			RAISE EXCEPTION 'Delivery-test provider-accept latency must be null or a nonnegative integer'
				USING ERRCODE = '55000';
		END IF;
		latency_value := CASE
			WHEN latency_is_null THEN NULL
			ELSE (channel_row ->> 'activationToProviderAcceptMs')::pg_catalog.numeric
		END;

		completed_is_null :=
			pg_catalog.jsonb_typeof(channel_row -> 'completedAt') = 'null';
		IF latency_is_null IS DISTINCT FROM completed_is_null THEN
			RAISE EXCEPTION 'Delivery-test latency and completion time must appear together'
				USING ERRCODE = '55000';
		END IF;
		IF NOT completed_is_null THEN
			IF pg_catalog.jsonb_typeof(channel_row -> 'completedAt') IS DISTINCT FROM 'string'
				OR (channel_row ->> 'completedAt')::pg_catalog.timestamptz > NEW."generated_at"
			THEN
				RAISE EXCEPTION 'Delivery-test channel completion must be a timestamp no later than report generation'
					USING ERRCODE = '55000';
			END IF;
		END IF;
		completed_at_value := CASE
			WHEN completed_is_null THEN NULL
			ELSE (channel_row ->> 'completedAt')::pg_catalog.timestamptz
		END;

		IF pg_catalog.jsonb_typeof(channel_row -> 'latestStateCounts') IS DISTINCT FROM 'array'
			OR pg_catalog.jsonb_array_length(channel_row -> 'latestStateCounts') > 6
		THEN
			RAISE EXCEPTION 'Delivery-test latest-state counts must be a bounded array'
				USING ERRCODE = '55000';
		END IF;

		counted_endpoints := 0;
		seen_states := ARRAY[]::text[];
		submitted_state_counts := '{}'::jsonb;
		has_non_success_state := false;
		FOR state_row IN
			SELECT value
			FROM pg_catalog.jsonb_array_elements(channel_row -> 'latestStateCounts')
		LOOP
			IF pg_catalog.jsonb_typeof(state_row) IS DISTINCT FROM 'object' THEN
				RAISE EXCEPTION 'Delivery-test latest-state row must be an object'
					USING ERRCODE = '55000';
			END IF;
			SELECT pg_catalog.count(*)::pg_catalog.int4
			INTO object_key_count
			FROM pg_catalog.jsonb_object_keys(state_row);
			IF object_key_count <> 2 OR NOT state_row ?& ARRAY['state', 'count'] THEN
				RAISE EXCEPTION 'Delivery-test latest-state fields must match the contract exactly'
					USING ERRCODE = '55000';
			END IF;

			state_name := state_row ->> 'state';
			IF state_name NOT IN (
				'attempted', 'provider-accepted', 'delivered',
				'failed', 'expired', 'unknown'
			) OR state_name = ANY(seen_states) THEN
				RAISE EXCEPTION 'Delivery-test latest-state rows must be valid and unique'
					USING ERRCODE = '55000';
			END IF;
			seen_states := pg_catalog.array_append(seen_states, state_name);

			IF pg_catalog.jsonb_typeof(state_row -> 'count') IS DISTINCT FROM 'number'
				OR state_row ->> 'count' !~ '^(0|[1-9][0-9]*)$'
			THEN
				RAISE EXCEPTION 'Delivery-test latest-state count must be a nonnegative integer'
					USING ERRCODE = '55000';
			END IF;
			state_count := (state_row ->> 'count')::pg_catalog.numeric;
			IF state_count > 12000 THEN
				RAISE EXCEPTION 'Delivery-test latest-state count exceeds its safe bound'
					USING ERRCODE = '54000';
			END IF;
			submitted_state_counts := submitted_state_counts
				|| pg_catalog.jsonb_build_object(state_name, state_count);
			counted_endpoints := counted_endpoints + state_count;
			IF state_name = 'unknown' THEN
				unknown_count := unknown_count + state_count;
			END IF;
			IF state_name IN ('failed', 'expired') THEN
				failed_or_expired_count := failed_or_expired_count + state_count;
			END IF;
			IF state_count > 0
				AND state_name NOT IN ('provider-accepted', 'delivered')
			THEN
				has_non_success_state := true;
			END IF;
		END LOOP;

		IF counted_endpoints <> endpoint_count THEN
			RAISE EXCEPTION 'Delivery-test latest-state counts must equal endpoint count'
				USING ERRCODE = '55000';
		END IF;
		IF NEW."status" = 'succeeded' AND (
			latency_is_null
			OR counted_endpoints <> endpoint_count
			OR has_non_success_state
		) THEN
			RAISE EXCEPTION 'Succeeded delivery-test reports require complete accepted or delivered truth'
				USING ERRCODE = '55000';
		END IF;
		submitted_channels := submitted_channels
			|| pg_catalog.jsonb_build_object(
				channel_name,
				pg_catalog.jsonb_build_object(
					'endpointCount', endpoint_count,
					'activationToProviderAcceptMs', latency_value,
					'latestStateCounts', submitted_state_counts,
					'completedAtEpochMs', CASE
						WHEN completed_at_value IS NULL THEN NULL
						ELSE pg_catalog.trunc(
							pg_catalog.date_part('epoch', completed_at_value) * 1000
						)::pg_catalog.int8
					END
				)
			);
	END LOOP;

	IF NOT ('push' = ANY(seen_channels)) OR NOT ('email' = ANY(seen_channels)) THEN
		RAISE EXCEPTION 'Delivery-test report requires push and email channels'
			USING ERRCODE = '55000';
	END IF;
	SELECT pg_catalog.count(DISTINCT endpoint."channel")::pg_catalog.int4
	INTO pinned_channel_total
	FROM public."delivery_test_runs" AS run
	JOIN public."delivery_test_target_endpoints" AS endpoint
		ON endpoint."target_set_version_id" = run."target_set_version_id"
		AND endpoint."target_set_version" = run."target_set_version"
	WHERE run."id" = NEW."run_id";
	IF pinned_channel_total IS NULL
		OR pinned_channel_total <> coalesce(pg_catalog.array_length(seen_channels, 1), 0)
	THEN
		RAISE EXCEPTION 'Delivery-test report must include every pinned target channel exactly once'
			USING ERRCODE = '55000';
	END IF;
	IF NEW."status" = 'incomplete' AND unknown_count = 0 THEN
		RAISE EXCEPTION 'Incomplete delivery-test report must retain explicit unknown truth'
			USING ERRCODE = '55000';
	END IF;
	IF NEW."status" = 'failed' AND failed_or_expired_count = 0 THEN
		RAISE EXCEPTION 'Failed delivery-test report must retain failed or expired truth'
			USING ERRCODE = '55000';
	END IF;
	IF submitted_channels IS DISTINCT FROM expected_channels
		OR NEW."status"::pg_catalog.text IS DISTINCT FROM expected_status
		OR NEW."reason_code" IS DISTINCT FROM expected_reason_code
	THEN
		RAISE EXCEPTION 'Delivery-test report must exactly match persisted attempt and evidence truth'
			USING ERRCODE = '55000';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "delivery_test_canary_eligibility_monotonic_insert_guard"
BEFORE INSERT ON public."delivery_test_canary_eligibility_facts"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_guard_delivery_test_canary_eligibility_insert"();--> statement-breakpoint

CREATE TRIGGER "delivery_test_target_sets_monotonic_insert_guard"
BEFORE INSERT ON public."delivery_test_target_set_versions"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_guard_delivery_test_target_set_insert"();--> statement-breakpoint

CREATE TRIGGER "delivery_test_target_endpoints_construction_guard"
BEFORE INSERT ON public."delivery_test_target_endpoints"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_guard_delivery_test_target_endpoint_insert"();--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "delivery_test_target_sets_complete_guard"
AFTER INSERT ON public."delivery_test_target_set_versions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_validate_delivery_test_target_set"();--> statement-breakpoint

CREATE TRIGGER "activation_previews_delivery_test_binding_guard"
BEFORE INSERT ON public."activation_previews"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_guard_delivery_test_binding_insert"();--> statement-breakpoint

CREATE TRIGGER "notification_intents_delivery_test_binding_guard"
BEFORE INSERT ON public."notification_intents"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_guard_delivery_test_binding_insert"();--> statement-breakpoint

CREATE TRIGGER "prepared_activations_delivery_test_guard"
BEFORE INSERT ON public."prepared_activations"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_reject_prepared_delivery_test"();--> statement-breakpoint

CREATE TRIGGER "channel_attempts_delivery_test_target_guard"
BEFORE INSERT ON public."channel_attempts"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_guard_delivery_test_attempt_insert"();--> statement-breakpoint

CREATE TRIGGER "delivery_test_reports_monotonic_insert_guard"
BEFORE INSERT ON public."delivery_test_reports"
FOR EACH ROW
EXECUTE FUNCTION public."psd_eoc_guard_delivery_test_report_insert"();--> statement-breakpoint

CREATE TRIGGER "delivery_test_target_set_versions_immutable_guard"
BEFORE UPDATE ON public."delivery_test_target_set_versions"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();--> statement-breakpoint
CREATE TRIGGER "delivery_test_target_set_versions_retain_guard"
BEFORE DELETE ON public."delivery_test_target_set_versions"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "delivery_test_canary_eligibility_facts_immutable_guard"
BEFORE UPDATE ON public."delivery_test_canary_eligibility_facts"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();--> statement-breakpoint
CREATE TRIGGER "delivery_test_canary_eligibility_facts_retain_guard"
BEFORE DELETE ON public."delivery_test_canary_eligibility_facts"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "delivery_test_target_endpoints_immutable_guard"
BEFORE UPDATE ON public."delivery_test_target_endpoints"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();--> statement-breakpoint
CREATE TRIGGER "delivery_test_target_endpoints_retain_guard"
BEFORE DELETE ON public."delivery_test_target_endpoints"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "delivery_test_runs_immutable_guard"
BEFORE UPDATE ON public."delivery_test_runs"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();--> statement-breakpoint
CREATE TRIGGER "delivery_test_runs_retain_guard"
BEFORE DELETE ON public."delivery_test_runs"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "delivery_test_reports_immutable_guard"
BEFORE UPDATE ON public."delivery_test_reports"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_immutable_mutation"();--> statement-breakpoint
CREATE TRIGGER "delivery_test_reports_retain_guard"
BEFORE DELETE ON public."delivery_test_reports"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_delete"();--> statement-breakpoint

REVOKE ALL ON FUNCTION public."psd_eoc_guard_delivery_test_canary_eligibility_insert"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_guard_delivery_test_target_set_insert"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_guard_delivery_test_target_endpoint_insert"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_validate_delivery_test_target_set"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_guard_delivery_test_binding_insert"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_reject_prepared_delivery_test"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_guard_delivery_test_attempt_insert"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_guard_delivery_test_report_insert"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint

REVOKE ALL PRIVILEGES ON TABLE
	public."delivery_test_canary_eligibility_facts",
	public."delivery_test_target_set_versions",
	public."delivery_test_target_endpoints",
	public."delivery_test_runs",
	public."delivery_test_reports"
FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE
	public."delivery_test_canary_eligibility_facts",
	public."delivery_test_target_set_versions",
	public."delivery_test_target_endpoints",
	public."delivery_test_runs",
	public."delivery_test_reports"
TO "psd_eoc_app";
