CREATE TYPE "public"."partner_notice_kind" AS ENUM('invitation', 'expiry-notice');--> statement-breakpoint
CREATE TYPE "public"."partner_provider_action" AS ENUM('enabled', 'disabled');--> statement-breakpoint
ALTER TYPE "public"."mutation_capability" ADD VALUE 'invite-partner';--> statement-breakpoint
ALTER TYPE "public"."mutation_capability" ADD VALUE 'disable-partner';--> statement-breakpoint
ALTER TYPE "public"."mutation_capability" ADD VALUE 'reconcile-partner-access';--> statement-breakpoint
CREATE TABLE "partner_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_admission_id" uuid NOT NULL,
	"kind" "partner_notice_kind" NOT NULL,
	"sent_by_user_id" uuid,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_provider_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_admission_id" uuid NOT NULL,
	"action" "partner_provider_action" NOT NULL,
	"provider_subject" varchar(255),
	"performed_by_user_id" uuid,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "partner_notices" ADD CONSTRAINT "partner_notices_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_notices" ADD CONSTRAINT "partner_notices_admission_fk" FOREIGN KEY ("partner_admission_id") REFERENCES "public"."partner_admissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_provider_syncs" ADD CONSTRAINT "partner_provider_syncs_performed_by_user_id_users_id_fk" FOREIGN KEY ("performed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_provider_syncs" ADD CONSTRAINT "partner_provider_syncs_admission_fk" FOREIGN KEY ("partner_admission_id") REFERENCES "public"."partner_admissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "partner_notices_admission_idx" ON "partner_notices" USING btree ("partner_admission_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_notices_one_expiry_notice_uq" ON "partner_notices" USING btree ("partner_admission_id") WHERE "partner_notices"."kind" = 'expiry-notice';--> statement-breakpoint
CREATE INDEX "partner_provider_syncs_admission_idx" ON "partner_provider_syncs" USING btree ("partner_admission_id","completed_at");--> statement-breakpoint
-- Both tables are records of what happened and are never changed: a
-- confirmed provider change and a sent email stay exactly as written. They
-- reuse the partner-admission append-only guard from 0059.
CREATE TRIGGER "partner_provider_syncs_append_only"
BEFORE UPDATE OR DELETE ON public."partner_provider_syncs"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_partner_admission_mutation"();--> statement-breakpoint
CREATE TRIGGER "partner_notices_append_only"
BEFORE UPDATE OR DELETE ON public."partner_notices"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_partner_admission_mutation"();--> statement-breakpoint
-- The application role reads and appends, naming every column the query
-- builder writes; no UPDATE or DELETE is granted.
GRANT SELECT ON TABLE public."partner_provider_syncs" TO "psd_eoc_app";--> statement-breakpoint
GRANT INSERT (
  "id", "partner_admission_id", "action", "provider_subject",
  "performed_by_user_id", "completed_at"
) ON TABLE public."partner_provider_syncs" TO "psd_eoc_app";--> statement-breakpoint
GRANT SELECT ON TABLE public."partner_notices" TO "psd_eoc_app";--> statement-breakpoint
GRANT INSERT (
  "id", "partner_admission_id", "kind", "sent_by_user_id", "sent_at"
) ON TABLE public."partner_notices" TO "psd_eoc_app";
