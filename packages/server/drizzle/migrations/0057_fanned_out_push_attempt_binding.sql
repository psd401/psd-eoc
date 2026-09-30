-- A staff push batch fans out to a recipient's devices enrolled after the
-- roster snapshot was published (resolution, then send-time eligibility, PR
-- #543). Those devices carry their own registration id as the endpoint id and
-- have no roster_endpoints row, so their first attempt insert failed
-- channel_attempts_endpoint_fk: the delivery-state route answered 503, the
-- worker retried, and the batch dead-lettered (production, 2026-09-30).
--
-- Each attempt and endpoint status now names what its endpoint id is, in two
-- columns the application never writes. A BEFORE INSERT trigger derives them:
-- a published endpoint keeps the exact composite foreign key it always had;
-- otherwise a staff push registration owned by the snapshot recipient is bound
-- through its own foreign key. Anything else is refused as before.
ALTER TABLE "channel_attempts" DROP CONSTRAINT "channel_attempts_endpoint_fk";--> statement-breakpoint
ALTER TABLE "endpoint_status_records" DROP CONSTRAINT "endpoint_status_records_endpoint_fk";--> statement-breakpoint
ALTER TABLE "channel_attempts" ADD COLUMN "published_endpoint_id" uuid;--> statement-breakpoint
ALTER TABLE "channel_attempts" ADD COLUMN "fanned_out_registration_id" uuid;--> statement-breakpoint
ALTER TABLE "endpoint_status_records" ADD COLUMN "published_endpoint_id" uuid;--> statement-breakpoint
ALTER TABLE "endpoint_status_records" ADD COLUMN "fanned_out_registration_id" uuid;--> statement-breakpoint
-- Every existing row satisfied the dropped foreign key, so each one names a
-- published endpoint. The immutability guards are lifted for this backfill
-- only, as migration 0035 did for roster_endpoints.
ALTER TABLE "channel_attempts" DISABLE TRIGGER "channel_attempts_immutable_guard";--> statement-breakpoint
UPDATE "channel_attempts" SET "published_endpoint_id" = "endpoint_id";--> statement-breakpoint
ALTER TABLE "channel_attempts" ENABLE TRIGGER "channel_attempts_immutable_guard";--> statement-breakpoint
ALTER TABLE "endpoint_status_records" DISABLE TRIGGER "endpoint_status_records_immutable_guard";--> statement-breakpoint
UPDATE "endpoint_status_records" SET "published_endpoint_id" = "endpoint_id";--> statement-breakpoint
ALTER TABLE "endpoint_status_records" ENABLE TRIGGER "endpoint_status_records_immutable_guard";--> statement-breakpoint
ALTER TABLE "channel_attempts" ADD CONSTRAINT "channel_attempts_published_endpoint_fk" FOREIGN KEY ("roster_snapshot_id","recipient_id","published_endpoint_id","roster_population","channel") REFERENCES "public"."roster_endpoints"("roster_snapshot_id","recipient_id","id","population","channel") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_attempts" ADD CONSTRAINT "channel_attempts_fanned_out_registration_fk" FOREIGN KEY ("fanned_out_registration_id") REFERENCES "public"."device_push_token_registrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_status_records" ADD CONSTRAINT "endpoint_status_records_published_endpoint_fk" FOREIGN KEY ("roster_snapshot_id","recipient_id","published_endpoint_id","population","channel") REFERENCES "public"."roster_endpoints"("roster_snapshot_id","recipient_id","id","population","channel") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_status_records" ADD CONSTRAINT "endpoint_status_records_fanned_out_registration_fk" FOREIGN KEY ("fanned_out_registration_id") REFERENCES "public"."device_push_token_registrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_attempts_fanned_out_registration_idx" ON "channel_attempts" USING btree ("fanned_out_registration_id");--> statement-breakpoint
CREATE INDEX "endpoint_status_records_fanned_out_registration_idx" ON "endpoint_status_records" USING btree ("fanned_out_registration_id");--> statement-breakpoint
ALTER TABLE "channel_attempts" ADD CONSTRAINT "channel_attempts_endpoint_identity" CHECK (num_nonnulls("channel_attempts"."published_endpoint_id", "channel_attempts"."fanned_out_registration_id") = 1
        and coalesce("channel_attempts"."published_endpoint_id", "channel_attempts"."fanned_out_registration_id") = "channel_attempts"."endpoint_id"
        and ("channel_attempts"."fanned_out_registration_id" is null or (
          "channel_attempts"."channel" = 'push' and "channel_attempts"."roster_population" = 'staff'
        )));--> statement-breakpoint
ALTER TABLE "endpoint_status_records" ADD CONSTRAINT "endpoint_status_records_endpoint_identity" CHECK (num_nonnulls("endpoint_status_records"."published_endpoint_id", "endpoint_status_records"."fanned_out_registration_id") = 1
        and coalesce("endpoint_status_records"."published_endpoint_id", "endpoint_status_records"."fanned_out_registration_id") = "endpoint_status_records"."endpoint_id"
        and ("endpoint_status_records"."fanned_out_registration_id" is null or (
          "endpoint_status_records"."channel" = 'push' and "endpoint_status_records"."population" = 'staff'
        )));--> statement-breakpoint
-- Derives the endpoint identity columns; caller-supplied values are ignored.
-- A published endpoint id never falls through to the registration branch, so
-- a published id claimed under the wrong recipient still fails the composite
-- foreign key exactly as before. The binding mirrors the live registration
-- query send-time eligibility uses (devices.ts loadLivePushRegistrations):
-- recipient -> user by Google subject or staff email -> device enrollment ->
-- registration. Liveness is deliberately not checked here: it depends on the
-- batch instant, and send-time eligibility is that boundary.
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
CREATE TRIGGER "channel_attempts_endpoint_identity_derivation"
BEFORE INSERT ON "channel_attempts"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_derive_endpoint_identity"();--> statement-breakpoint
CREATE TRIGGER "endpoint_status_records_endpoint_identity_derivation"
BEFORE INSERT ON "endpoint_status_records"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_derive_endpoint_identity"();
