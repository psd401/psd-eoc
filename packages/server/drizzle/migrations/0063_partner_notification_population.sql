-- Partners (admitted first responders outside the district) become a third
-- notification population beside staff and synthetic training (#597). They
-- are a slice of a live staff incident, never an event population and never
-- rostered: an event, its previews, and every roster table keep refusing
-- `partner`, so this migration changes no existing staff or synthetic row and
-- writes nothing. Planning and delivery start using the slice later.
--
-- A value added to an enum cannot be written as an enum literal in the same
-- transaction (55P04), and drizzle applies every pending migration in one
-- transaction, so every comparison with 'partner' below is on text.
ALTER TYPE "public"."roster_population" ADD VALUE 'partner';--> statement-breakpoint
-- Where a partner slice reaches one admitted partner: the admission itself
-- for email, or one of the partner's own push registrations or SMS consents.
-- It is the partner counterpart of a published roster endpoint, and copies no
-- destination: the address, token, or number stays in its source row.
CREATE TABLE "partner_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_admission_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"push_registration_id" uuid,
	"sms_consent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_endpoints_binding_uq" UNIQUE("partner_admission_id","id","channel"),
	CONSTRAINT "partner_endpoints_channel_source" CHECK ((
        "partner_endpoints"."channel" = 'email'
        and "partner_endpoints"."push_registration_id" is null
        and "partner_endpoints"."sms_consent_id" is null
      ) or (
        "partner_endpoints"."channel" = 'push'
        and "partner_endpoints"."push_registration_id" is not null
        and "partner_endpoints"."sms_consent_id" is null
      ) or (
        "partner_endpoints"."channel" = 'sms'
        and "partner_endpoints"."sms_consent_id" is not null
        and "partner_endpoints"."push_registration_id" is null
      ))
);
--> statement-breakpoint
ALTER TABLE "channel_attempts" DROP CONSTRAINT "channel_attempts_endpoint_identity";--> statement-breakpoint
ALTER TABLE "channel_attempts" DROP CONSTRAINT "channel_attempts_classification";--> statement-breakpoint
ALTER TABLE "dispatch_batches" DROP CONSTRAINT "dispatch_batches_classification";--> statement-breakpoint
ALTER TABLE "endpoint_status_records" DROP CONSTRAINT "endpoint_status_records_endpoint_identity";--> statement-breakpoint
ALTER TABLE "notification_intents" DROP CONSTRAINT "notification_intents_classification";--> statement-breakpoint
ALTER TABLE "notification_intents" DROP CONSTRAINT "notification_intents_authorization_truth";--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_classification";--> statement-breakpoint
-- A partner slice belongs to a staff event and is pinned to that event's
-- staff snapshot, so its population is not the event's. The intent alone now
-- binds event and snapshot, through the generated event_roster_population
-- column. Outbox records, batches, and attempts carried a second copy of the
-- same two foreign keys; each already reaches the intent through a composite
-- foreign key over event, classification, snapshot, and population, so those
-- copies are implied and are dropped rather than restated.
ALTER TABLE "channel_attempts" DROP CONSTRAINT "channel_attempts_event_targeting_fk";
--> statement-breakpoint
ALTER TABLE "channel_attempts" DROP CONSTRAINT "channel_attempts_roster_population_fk";
--> statement-breakpoint
ALTER TABLE "dispatch_batches" DROP CONSTRAINT "dispatch_batches_event_targeting_fk";
--> statement-breakpoint
ALTER TABLE "dispatch_batches" DROP CONSTRAINT "dispatch_batches_roster_population_fk";
--> statement-breakpoint
ALTER TABLE "notification_intents" DROP CONSTRAINT "notification_intents_event_truth_fk";
--> statement-breakpoint
ALTER TABLE "notification_intents" DROP CONSTRAINT "notification_intents_roster_population_fk";
--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_event_targeting_fk";
--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_roster_population_fk";
--> statement-breakpoint
-- One human-confirmed request records the staff intent and, for a live
-- incident, the partner slice beside it: one intent per population per
-- request. notification_intents_authorization_truth still binds each to the
-- request's authorization.
DROP INDEX "notification_intents_request_uq";--> statement-breakpoint
ALTER TABLE "channel_attempts" ADD COLUMN "partner_endpoint_id" uuid;--> statement-breakpoint
ALTER TABLE "endpoint_status_records" ADD COLUMN "partner_endpoint_id" uuid;--> statement-breakpoint
-- The event's population: staff for a partner slice, otherwise the intent's
-- own. Spelled without the new literal (see the header).
ALTER TABLE "notification_intents" ADD COLUMN "event_roster_population" "roster_population" GENERATED ALWAYS AS (case when roster_population in ('staff', 'synthetic') then roster_population else 'staff'::roster_population end) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "partner_endpoints" ADD CONSTRAINT "partner_endpoints_admission_fk" FOREIGN KEY ("partner_admission_id") REFERENCES "public"."partner_admissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_endpoints" ADD CONSTRAINT "partner_endpoints_push_registration_fk" FOREIGN KEY ("push_registration_id") REFERENCES "public"."device_push_token_registrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_endpoints" ADD CONSTRAINT "partner_endpoints_sms_consent_fk" FOREIGN KEY ("sms_consent_id") REFERENCES "public"."staff_sms_consents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "partner_endpoints_email_uq" ON "partner_endpoints" USING btree ("partner_admission_id") WHERE "partner_endpoints"."channel" = 'email';--> statement-breakpoint
CREATE UNIQUE INDEX "partner_endpoints_push_registration_uq" ON "partner_endpoints" USING btree ("partner_admission_id","push_registration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_endpoints_sms_consent_uq" ON "partner_endpoints" USING btree ("partner_admission_id","sms_consent_id");--> statement-breakpoint
ALTER TABLE "channel_attempts" ADD CONSTRAINT "channel_attempts_partner_endpoint_fk" FOREIGN KEY ("recipient_id","partner_endpoint_id","channel") REFERENCES "public"."partner_endpoints"("partner_admission_id","id","channel") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_status_records" ADD CONSTRAINT "endpoint_status_records_partner_endpoint_fk" FOREIGN KEY ("recipient_id","partner_endpoint_id","channel") REFERENCES "public"."partner_endpoints"("partner_admission_id","id","channel") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_event_truth_fk" FOREIGN KEY ("event_id","event_kind","template_mode","event_type_version_id","roster_snapshot_id","event_roster_population") REFERENCES "public"."events"("id","kind","template_mode","event_type_version_id","roster_snapshot_id","roster_population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_roster_population_fk" FOREIGN KEY ("roster_snapshot_id","event_roster_population") REFERENCES "public"."roster_snapshots"("id","population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_attempts_partner_endpoint_idx" ON "channel_attempts" USING btree ("partner_endpoint_id");--> statement-breakpoint
CREATE INDEX "endpoint_status_records_partner_endpoint_idx" ON "endpoint_status_records" USING btree ("partner_endpoint_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_intents_request_population_uq" ON "notification_intents" USING btree ("request_id","roster_population");--> statement-breakpoint
-- Every roster table reaches roster_source_configurations through its
-- population foreign keys, so refusing `partner` here keeps it out of the
-- whole roster. Events, previews, and transitions already list their legal
-- populations and so refuse it unchanged.
ALTER TABLE "roster_source_configurations" ADD CONSTRAINT "roster_source_configurations_rostered_population" CHECK ("roster_source_configurations"."population"::text in ('staff', 'synthetic'));--> statement-breakpoint
-- Exactly one of three bindings names an endpoint now, and a partner slice
-- binds a partner endpoint and nothing else. A drill or test never reaches a
-- partner; only a live incident does.
ALTER TABLE "channel_attempts" ADD CONSTRAINT "channel_attempts_endpoint_identity" CHECK (num_nonnulls("channel_attempts"."published_endpoint_id", "channel_attempts"."fanned_out_registration_id", "channel_attempts"."partner_endpoint_id") = 1
        and coalesce("channel_attempts"."published_endpoint_id", "channel_attempts"."fanned_out_registration_id", "channel_attempts"."partner_endpoint_id") = "channel_attempts"."endpoint_id"
        and ("channel_attempts"."fanned_out_registration_id" is null or (
          "channel_attempts"."channel" = 'push' and "channel_attempts"."roster_population" = 'staff'
        ))
        and ("channel_attempts"."partner_endpoint_id" is not null) = ("channel_attempts"."roster_population"::text = 'partner'));--> statement-breakpoint
ALTER TABLE "channel_attempts" ADD CONSTRAINT "channel_attempts_classification" CHECK ((
        "channel_attempts"."event_kind" = 'incident' and "channel_attempts"."template_mode" = 'real'
        and "channel_attempts"."roster_population"::text in ('staff', 'partner')
      ) or (
        "channel_attempts"."event_kind" = 'drill' and "channel_attempts"."template_mode" = 'drill'
        and "channel_attempts"."roster_population"::text in ('staff', 'synthetic')
      ) or (
        "channel_attempts"."event_kind" = 'test' and "channel_attempts"."template_mode" = 'drill'
        and "channel_attempts"."roster_population" = 'synthetic'
      ));--> statement-breakpoint
ALTER TABLE "dispatch_batches" ADD CONSTRAINT "dispatch_batches_classification" CHECK ((
        "dispatch_batches"."event_kind" = 'incident' and "dispatch_batches"."template_mode" = 'real'
        and "dispatch_batches"."roster_population"::text in ('staff', 'partner')
      ) or (
        "dispatch_batches"."event_kind" = 'drill' and "dispatch_batches"."template_mode" = 'drill'
        and "dispatch_batches"."roster_population"::text in ('staff', 'synthetic')
      ) or (
        "dispatch_batches"."event_kind" = 'test' and "dispatch_batches"."template_mode" = 'drill'
        and "dispatch_batches"."roster_population" = 'synthetic'
      ));--> statement-breakpoint
ALTER TABLE "endpoint_status_records" ADD CONSTRAINT "endpoint_status_records_endpoint_identity" CHECK (num_nonnulls("endpoint_status_records"."published_endpoint_id", "endpoint_status_records"."fanned_out_registration_id", "endpoint_status_records"."partner_endpoint_id") = 1
        and coalesce("endpoint_status_records"."published_endpoint_id", "endpoint_status_records"."fanned_out_registration_id", "endpoint_status_records"."partner_endpoint_id") = "endpoint_status_records"."endpoint_id"
        and ("endpoint_status_records"."fanned_out_registration_id" is null or (
          "endpoint_status_records"."channel" = 'push' and "endpoint_status_records"."population" = 'staff'
        ))
        and ("endpoint_status_records"."partner_endpoint_id" is not null) = ("endpoint_status_records"."population"::text = 'partner'));--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_classification" CHECK ((
        "notification_intents"."event_kind" = 'incident' and "notification_intents"."template_mode" = 'real'
        and "notification_intents"."roster_population"::text in ('staff', 'partner')
      ) or (
        "notification_intents"."event_kind" = 'drill' and "notification_intents"."template_mode" = 'drill'
        and "notification_intents"."roster_population"::text in ('staff', 'synthetic')
      ) or (
        "notification_intents"."event_kind" = 'test' and "notification_intents"."template_mode" = 'drill'
        and "notification_intents"."roster_population" = 'synthetic'
      ));--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_authorization_truth" CHECK ((
        "notification_intents"."authorization" ->> 'requestId' is not distinct from "notification_intents"."request_id"::text
      ) and case
        when "notification_intents"."purpose" = 'activation' and "notification_intents"."roster_population"::text in ('staff', 'partner') then
          "notification_intents"."authorization" ->> 'kind' is not distinct from 'human-confirmed'
          and "notification_intents"."created_by" ->> 'kind' is not distinct from 'human'
        when "notification_intents"."purpose" = 'activation' and "notification_intents"."roster_population" = 'synthetic' then
          "notification_intents"."authorization" ->> 'kind' is not distinct from 'synthetic-training'
        when "notification_intents"."purpose" <> 'activation' and "notification_intents"."roster_population"::text in ('staff', 'partner') then
          "notification_intents"."authorization" ->> 'kind' is not distinct from 'human-confirmed-lifecycle'
          and "notification_intents"."authorization" ->> 'purpose' is not distinct from "notification_intents"."purpose"::text
          and "notification_intents"."created_by" ->> 'kind' is not distinct from 'human'
        when "notification_intents"."purpose" <> 'activation' and "notification_intents"."roster_population" = 'synthetic' then
          "notification_intents"."authorization" ->> 'kind' is not distinct from 'synthetic-lifecycle'
          and "notification_intents"."authorization" ->> 'purpose' is not distinct from "notification_intents"."purpose"::text
        else false
      end);--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_classification" CHECK ((
        "outbox"."event_kind" = 'incident' and "outbox"."template_mode" = 'real'
        and "outbox"."roster_population"::text in ('staff', 'partner')
      ) or (
        "outbox"."event_kind" = 'drill' and "outbox"."template_mode" = 'drill'
        and "outbox"."roster_population"::text in ('staff', 'synthetic')
      ) or (
        "outbox"."event_kind" = 'test' and "outbox"."template_mode" = 'drill'
        and "outbox"."roster_population" = 'synthetic'
      ));--> statement-breakpoint
-- A partner endpoint is a fact about where somebody was reachable and is
-- never changed; a new device or number is a new row. Reuses the partner
-- append-only guard from 0059, as 0060 to 0062 do.
CREATE TRIGGER "partner_endpoints_append_only"
BEFORE UPDATE OR DELETE ON public."partner_endpoints"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_partner_admission_mutation"();--> statement-breakpoint
-- A partner's push registration or SMS consent must be the admitted person's
-- own: a user signed in through the partner identity provider (not district
-- Google) under the admitted address. Email needs no check; its endpoint is
-- the admission.
CREATE FUNCTION public."psd_eoc_check_partner_endpoint_owner"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	admitted_email text;
	owned boolean;
BEGIN
	SELECT admission.email INTO admitted_email
	FROM public.partner_admissions AS admission
	WHERE admission.id = NEW.partner_admission_id;
	IF NEW.push_registration_id IS NOT NULL THEN
		SELECT EXISTS (
			SELECT 1
			FROM public.device_push_token_registrations AS registration
			JOIN public.device_enrollments AS enrollment
				ON enrollment.id = registration.device_enrollment_id
			JOIN public.users AS owner
				ON owner.id = enrollment.user_id
			WHERE registration.id = NEW.push_registration_id
				AND owner.identity_issuer <> 'https://accounts.google.com'
				AND owner.email = admitted_email
		) INTO owned;
	ELSIF NEW.sms_consent_id IS NOT NULL THEN
		SELECT EXISTS (
			SELECT 1
			FROM public.staff_sms_consents AS consent
			JOIN public.users AS owner
				ON owner.id = consent.user_id
			WHERE consent.id = NEW.sms_consent_id
				AND owner.identity_issuer <> 'https://accounts.google.com'
				AND owner.email = admitted_email
		) INTO owned;
	ELSE
		owned := true;
	END IF;
	IF NOT owned THEN
		RAISE EXCEPTION 'A partner endpoint must be the admitted partner''s own registration or consent'
			USING ERRCODE = '23514', CONSTRAINT = 'partner_endpoints_owner';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "partner_endpoints_owner_check"
BEFORE INSERT ON public."partner_endpoints"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_check_partner_endpoint_owner"();--> statement-breakpoint
-- Supersedes the 0057 derivation (that migration is left as applied). A
-- partner row binds only a partner endpoint owned by its recipient (the
-- admission) on the same channel, and never falls through to the published
-- or registration branches; staff and synthetic rows derive exactly as
-- before. Liveness is still not checked here: send-time eligibility is that
-- boundary.
CREATE OR REPLACE FUNCTION public."psd_eoc_derive_endpoint_identity"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	row_population text;
BEGIN
	IF TG_TABLE_SCHEMA <> 'public'
		OR TG_TABLE_NAME NOT IN ('channel_attempts', 'endpoint_status_records')
		OR TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'INSERT'
	THEN
		RAISE EXCEPTION 'Endpoint identity derivation is attached to the wrong trigger'
			USING ERRCODE = '42P17';
	END IF;
	IF TG_TABLE_NAME = 'channel_attempts' THEN
		row_population := NEW.roster_population::text;
	ELSE
		row_population := NEW.population::text;
	END IF;
	NEW.published_endpoint_id := NULL;
	NEW.fanned_out_registration_id := NULL;
	NEW.partner_endpoint_id := NULL;
	IF row_population = 'partner' THEN
		IF EXISTS (
			SELECT 1
			FROM public.partner_endpoints AS endpoint
			WHERE endpoint.id = NEW.endpoint_id
				AND endpoint.partner_admission_id = NEW.recipient_id
				AND endpoint.channel::text = NEW.channel::text
		) THEN
			NEW.partner_endpoint_id := NEW.endpoint_id;
			RETURN NEW;
		END IF;
		RAISE EXCEPTION 'The endpoint is not a partner endpoint of its admission'
			USING ERRCODE = '23503', CONSTRAINT = TG_TABLE_NAME || '_endpoint_binding';
	END IF;
	IF EXISTS (
		SELECT 1
		FROM public.roster_endpoints AS endpoint
		WHERE endpoint.roster_snapshot_id = NEW.roster_snapshot_id
			AND endpoint.id = NEW.endpoint_id
	) THEN
		NEW.published_endpoint_id := NEW.endpoint_id;
		RETURN NEW;
	END IF;
	IF NEW.channel::text = 'push'
		AND row_population = 'staff'
		AND EXISTS (
			SELECT 1
			FROM public.roster_recipients AS recipient
			JOIN public.users AS owner
				ON owner.google_subject = recipient.google_subject
				OR pg_catalog.lower(owner.email) = pg_catalog.lower(recipient.staff_email)
			JOIN public.device_enrollments AS enrollment
				ON enrollment.user_id = owner.id
			JOIN public.device_push_token_registrations AS registration
				ON registration.device_enrollment_id = enrollment.id
			WHERE recipient.roster_snapshot_id = NEW.roster_snapshot_id
				AND recipient.id = NEW.recipient_id
				AND recipient.population::text = row_population
				AND registration.id = NEW.endpoint_id
		)
	THEN
		NEW.fanned_out_registration_id := NEW.endpoint_id;
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'The endpoint is neither published in the snapshot nor a push registration of its recipient'
		USING ERRCODE = '23503', CONSTRAINT = TG_TABLE_NAME || '_endpoint_binding';
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_check_partner_endpoint_owner"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
-- PostgreSQL does not apply an earlier GRANT ... ON ALL TABLES to a table
-- created later. The application role reads and appends, naming every column
-- the query builder writes (see 0042 and 0054); no UPDATE or DELETE.
GRANT SELECT ON TABLE public."partner_endpoints" TO "psd_eoc_app";--> statement-breakpoint
GRANT INSERT (
  "id", "partner_admission_id", "channel", "push_registration_id",
  "sms_consent_id", "created_at"
) ON TABLE public."partner_endpoints" TO "psd_eoc_app";
