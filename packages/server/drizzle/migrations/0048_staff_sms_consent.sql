ALTER TYPE "public"."mutation_capability" ADD VALUE 'record-sms-consent' BEFORE 'create-facility';--> statement-breakpoint
ALTER TYPE "public"."mutation_capability" ADD VALUE 'withdraw-sms-consent' BEFORE 'create-facility';--> statement-breakpoint
CREATE TABLE "staff_sms_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"phone_number" varchar(16) NOT NULL,
	"disclosure_version" varchar(10) NOT NULL,
	"source" "invocation_source" NOT NULL,
	"supersedes_consent_id" uuid,
	"withdrawn_at" timestamp with time zone,
	"consented_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_sms_consents_supersedes_uq" UNIQUE("supersedes_consent_id"),
	CONSTRAINT "staff_sms_consents_e164" CHECK ("staff_sms_consents"."phone_number" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "staff_sms_consents_disclosure_version" CHECK ("staff_sms_consents"."disclosure_version" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
	CONSTRAINT "staff_sms_consents_withdrawal_not_before_consent" CHECK ("staff_sms_consents"."withdrawn_at" is null or "staff_sms_consents"."withdrawn_at" >= "staff_sms_consents"."consented_at")
);
--> statement-breakpoint
ALTER TABLE "staff_sms_consents" ADD CONSTRAINT "staff_sms_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_sms_consents" ADD CONSTRAINT "staff_sms_consents_supersedes_fk" FOREIGN KEY ("supersedes_consent_id") REFERENCES "public"."staff_sms_consents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_sms_consents_one_live_per_user_uq" ON "staff_sms_consents" USING btree ("user_id") WHERE "staff_sms_consents"."withdrawn_at" is null;--> statement-breakpoint
CREATE INDEX "staff_sms_consents_user_idx" ON "staff_sms_consents" USING btree ("user_id","consented_at");--> statement-breakpoint
-- Grants the application role what it needs on "staff_sms_consents". Without
-- these the table is reachable by its owner and by nobody else: migrations
-- 0036, 0040, and 0041 each had to correct exactly this omission, because
-- PostgreSQL does not apply an earlier GRANT ... ON ALL TABLES to a table
-- created later, and this database defines no default privileges.
--
-- INSERT names every column deliberately. Migration 0042 established why:
-- PostgreSQL requires INSERT privilege on every column NAMED in a statement,
-- and the query builder names all of them and writes DEFAULT for the ones the
-- caller omits. A narrower list would refuse every consent insert, which is
-- the failure that left this system unable to send at all.
GRANT SELECT ON TABLE public."staff_sms_consents" TO "psd_eoc_app";
--> statement-breakpoint
GRANT INSERT (
	"id", "user_id", "phone_number", "disclosure_version", "source",
	"supersedes_consent_id", "withdrawn_at", "consented_at"
) ON TABLE public."staff_sms_consents" TO "psd_eoc_app";
--> statement-breakpoint
-- Withdrawal is the only permitted mutation, so UPDATE stays column-scoped to
-- the one column it sets. An UPDATE names only the columns it assigns, so this
-- grant works as written where a column-scoped INSERT could not.
GRANT UPDATE ("withdrawn_at") ON TABLE public."staff_sms_consents"
TO "psd_eoc_app";
--> statement-breakpoint
-- No DELETE is granted, and none should be. A carrier reviewing a toll-free or
-- 10DLC registration can ask what a given number agreed to and when. Deleting
-- a consent would destroy the only evidence that a send to that number was
-- ever permitted, so a withdrawal sets a timestamp and the row survives.
CREATE FUNCTION public."psd_eoc_guard_sms_consent_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	IF TG_RELID <> 'public.staff_sms_consents'::pg_catalog.regclass
		OR TG_LEVEL <> 'ROW' OR TG_OP NOT IN ('UPDATE', 'DELETE') THEN
		RAISE EXCEPTION 'Unexpected SMS consent mutation guard context';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'SMS consent evidence is append-only';
	END IF;
	-- Withdrawal is one-way and sets nothing else. Re-consenting inserts a new
	-- row that supersedes this one rather than reviving it, so a withdrawn
	-- consent never becomes live again and the wording each consent carried
	-- stays attached to the period it covered.
	IF OLD."withdrawn_at" IS NOT NULL
		OR NEW."withdrawn_at" IS NULL
		OR NEW."id" IS DISTINCT FROM OLD."id"
		OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
		OR NEW."phone_number" IS DISTINCT FROM OLD."phone_number"
		OR NEW."disclosure_version" IS DISTINCT FROM OLD."disclosure_version"
		OR NEW."source" IS DISTINCT FROM OLD."source"
		OR NEW."supersedes_consent_id" IS DISTINCT FROM OLD."supersedes_consent_id"
		OR NEW."consented_at" IS DISTINCT FROM OLD."consented_at" THEN
		RAISE EXCEPTION 'SMS consent evidence is append-only';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "staff_sms_consents_append_only"
BEFORE UPDATE OR DELETE ON public."staff_sms_consents"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_guard_sms_consent_mutation"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_guard_sms_consent_mutation"()
FROM PUBLIC, "psd_eoc_app";
