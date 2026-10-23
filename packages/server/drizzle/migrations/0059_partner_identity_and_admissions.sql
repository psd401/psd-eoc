CREATE TYPE "public"."partner_admission_ending_reason" AS ENUM('disabled', 'expired', 'superseded');--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'partner';--> statement-breakpoint
CREATE TABLE "partner_admission_endings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_admission_id" uuid NOT NULL,
	"reason" "partner_admission_ending_reason" NOT NULL,
	"ended_by_user_id" uuid,
	"ended_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_admission_endings_actor_matches_reason" CHECK (("partner_admission_endings"."reason" = 'expired') = ("partner_admission_endings"."ended_by_user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "partner_admissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"display_name" varchar(160) NOT NULL,
	"agency" varchar(160) NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"admitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone GENERATED ALWAYS AS (((admitted_at at time zone 'UTC') + interval '1 year') at time zone 'UTC') STORED NOT NULL,
	"supersedes_admission_id" uuid,
	CONSTRAINT "partner_admissions_normalized_email" CHECK ("partner_admissions"."email" = lower("partner_admissions"."email")
        and "partner_admissions"."email" = btrim("partner_admissions"."email")
        and length("partner_admissions"."email") between 3 and 320
        and "partner_admissions"."email" ~ '^[^[:space:]@]+@[^[:space:]@]+$'),
	CONSTRAINT "partner_admissions_display_name_present" CHECK (length(btrim("partner_admissions"."display_name")) > 0),
	CONSTRAINT "partner_admissions_agency_present" CHECK (length(btrim("partner_admissions"."agency")) > 0),
	CONSTRAINT "partner_admissions_not_self_superseding" CHECK ("partner_admissions"."supersedes_admission_id" is null or "partner_admissions"."supersedes_admission_id" <> "partner_admissions"."id")
);
--> statement-breakpoint
-- A person is now identified by issuer and subject together, so somebody
-- who signs in through an identity provider other than district Google can be
-- represented. Every existing row is a Google identity and is backfilled as
-- one; google_subject stays for code and installed builds that still read it
-- and is null only for a non-Google identity.
ALTER TABLE "users" ALTER COLUMN "google_subject" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "identity_issuer" varchar(255);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "identity_subject" varchar(255);--> statement-breakpoint
-- A server still running the previous release while this migration lands
-- writes users with google_subject only. This fills the identity in for such
-- a writer, the same way the backfill below does, instead of refusing a
-- first-time staff sign-in during the deploy.
CREATE FUNCTION public."psd_eoc_default_google_identity"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	IF NEW."identity_issuer" IS NULL
		AND NEW."identity_subject" IS NULL
		AND NEW."google_subject" IS NOT NULL
	THEN
		NEW."identity_issuer" := 'https://accounts.google.com';
		NEW."identity_subject" := NEW."google_subject";
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "users_default_google_identity"
BEFORE INSERT ON public."users"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_default_google_identity"();--> statement-breakpoint
-- Who somebody is never changes after the row exists: a different issuer or
-- subject is a different person and gets a different row.
CREATE FUNCTION public."psd_eoc_guard_user_identity_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	IF NEW."identity_issuer" IS DISTINCT FROM OLD."identity_issuer"
		OR NEW."identity_subject" IS DISTINCT FROM OLD."identity_subject"
		OR NEW."google_subject" IS DISTINCT FROM OLD."google_subject"
	THEN
		RAISE EXCEPTION 'A user identity (issuer and subject) is immutable'
			USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
UPDATE "users"
SET "identity_issuer" = 'https://accounts.google.com',
	"identity_subject" = "google_subject"
WHERE "identity_issuer" IS NULL;--> statement-breakpoint
CREATE TRIGGER "users_identity_guard"
BEFORE UPDATE ON public."users"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_guard_user_identity_mutation"();--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "identity_issuer" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "identity_subject" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "partner_admission_endings" ADD CONSTRAINT "partner_admission_endings_admission_fk" FOREIGN KEY ("partner_admission_id") REFERENCES "public"."partner_admissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_admission_endings" ADD CONSTRAINT "partner_admission_endings_ended_by_user_id_users_id_fk" FOREIGN KEY ("ended_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_admissions" ADD CONSTRAINT "partner_admissions_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_admissions" ADD CONSTRAINT "partner_admissions_supersedes_fk" FOREIGN KEY ("supersedes_admission_id") REFERENCES "public"."partner_admissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "partner_admission_endings_admission_uq" ON "partner_admission_endings" USING btree ("partner_admission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_admissions_supersedes_uq" ON "partner_admissions" USING btree ("supersedes_admission_id");--> statement-breakpoint
CREATE INDEX "partner_admissions_email_idx" ON "partner_admissions" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_identity_uq" ON "users" USING btree ("identity_issuer","identity_subject");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_google_subject_is_google_identity" CHECK (("users"."identity_issuer" = 'https://accounts.google.com') = ("users"."google_subject" is not null)
        and ("users"."google_subject" is null or "users"."google_subject" = "users"."identity_subject"));--> statement-breakpoint
-- An access group grants a staff role and never `partner`. The comparison is
-- on text because a value added to an enum earlier in this transaction cannot
-- yet be written as an enum literal.
ALTER TABLE "group_sources" ADD CONSTRAINT "group_sources_granted_role_not_partner" CHECK ("group_sources"."granted_role" is null or "group_sources"."granted_role"::text <> 'partner');--> statement-breakpoint
-- `partner` never sits beside a staff role on one person. Roles are decided
-- from groups and admissions rather than stored, but the legacy stored grants
-- are held to the same rule: `partner` only for a non-Google identity, a staff
-- role only for a Google one. Since an identity has one issuer, no person can
-- hold both.
CREATE FUNCTION public."psd_eoc_guard_partner_role_exclusive"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	holder_issuer text;
BEGIN
	-- Nested so `granted` is only read on the table that has it.
	IF TG_TABLE_NAME = 'user_role_changes' THEN
		IF NOT NEW."granted" THEN
			RETURN NEW;
		END IF;
	END IF;
	SELECT "identity_issuer" INTO holder_issuer
	FROM public."users"
	WHERE "id" = NEW."user_id";
	IF (NEW."role"::text = 'partner') = (holder_issuer = 'https://accounts.google.com') THEN
		RAISE EXCEPTION 'The partner role is held only by a non-Google identity, and staff roles only by a Google one'
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "user_roles_partner_exclusive"
BEFORE INSERT ON public."user_roles"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_guard_partner_role_exclusive"();--> statement-breakpoint
CREATE TRIGGER "user_role_changes_partner_exclusive"
BEFORE INSERT ON public."user_role_changes"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_guard_partner_role_exclusive"();--> statement-breakpoint
-- Partner admissions and their endings are append-only facts: no row is
-- ever changed or removed. An admission ends with an ending row, and a
-- renewal or a corrected address is a new admission.
CREATE FUNCTION public."psd_eoc_reject_partner_admission_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	RAISE EXCEPTION 'Partner admission records are append-only on %', TG_TABLE_NAME
		USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "partner_admissions_append_only"
BEFORE UPDATE OR DELETE ON public."partner_admissions"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_partner_admission_mutation"();--> statement-breakpoint
CREATE TRIGGER "partner_admission_endings_append_only"
BEFORE UPDATE OR DELETE ON public."partner_admission_endings"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_partner_admission_mutation"();--> statement-breakpoint
-- Checked at commit, once every row of a renewal or correction is written:
-- at most one unended admission per address, an admission that supersedes
-- another is matched by a `superseded` ending of that one, and a `superseded`
-- ending is matched by the admission that superseded it. Deferred because a
-- renewal writes the new admission before the old one's ending.
CREATE FUNCTION public."psd_eoc_check_partner_admission_lineage"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	admission_email text;
BEGIN
	IF TG_TABLE_NAME = 'partner_admissions' THEN
		admission_email := NEW."email";
		IF NEW."supersedes_admission_id" IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM public."partner_admission_endings"
			WHERE "partner_admission_id" = NEW."supersedes_admission_id"
				AND "reason" = 'superseded'
		) THEN
			RAISE EXCEPTION 'A superseding partner admission requires a superseded ending of the admission it replaces'
				USING ERRCODE = '23514';
		END IF;
	ELSE
		SELECT "email" INTO admission_email
		FROM public."partner_admissions"
		WHERE "id" = NEW."partner_admission_id";
		IF NEW."reason" = 'superseded' AND NOT EXISTS (
			SELECT 1 FROM public."partner_admissions"
			WHERE "supersedes_admission_id" = NEW."partner_admission_id"
		) THEN
			RAISE EXCEPTION 'A superseded partner admission requires the admission that superseded it'
				USING ERRCODE = '23514';
		END IF;
	END IF;
	IF (
		SELECT count(*)
		FROM public."partner_admissions" AS admission
		WHERE admission."email" = admission_email
			AND NOT EXISTS (
				SELECT 1 FROM public."partner_admission_endings" AS ending
				WHERE ending."partner_admission_id" = admission."id"
			)
	) > 1 THEN
		RAISE EXCEPTION 'An address has at most one unended partner admission'
			USING ERRCODE = '23505';
	END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "partner_admissions_lineage_check"
AFTER INSERT ON public."partner_admissions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_check_partner_admission_lineage"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "partner_admission_endings_lineage_check"
AFTER INSERT ON public."partner_admission_endings"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_check_partner_admission_lineage"();--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_default_google_identity"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_guard_user_identity_mutation"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_guard_partner_role_exclusive"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_check_partner_admission_lineage"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_reject_partner_admission_mutation"() FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
-- The application role reads both tables and appends to them, naming every
-- column the query builder writes (PostgreSQL requires INSERT on every column
-- a statement names; see migrations 0042 and 0054). `expires_at` is generated,
-- so nobody writes it, and no UPDATE or DELETE is granted on either table.
GRANT SELECT ON TABLE public."partner_admissions" TO "psd_eoc_app";--> statement-breakpoint
GRANT INSERT (
  "id", "email", "display_name", "agency", "invited_by_user_id",
  "admitted_at", "supersedes_admission_id"
) ON TABLE public."partner_admissions" TO "psd_eoc_app";--> statement-breakpoint
GRANT SELECT ON TABLE public."partner_admission_endings" TO "psd_eoc_app";--> statement-breakpoint
GRANT INSERT (
  "id", "partner_admission_id", "reason", "ended_by_user_id", "ended_at"
) ON TABLE public."partner_admission_endings" TO "psd_eoc_app";
