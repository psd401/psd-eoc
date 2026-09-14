ALTER TYPE "public"."mutation_capability" ADD VALUE 'admit-account';--> statement-breakpoint
ALTER TYPE "public"."mutation_capability" ADD VALUE 'revoke-admitted-account';--> statement-breakpoint
CREATE TABLE "admitted_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"note" varchar(240) DEFAULT '' NOT NULL,
	"admitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"admitted_by_user_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	CONSTRAINT "admitted_accounts_normalized_email" CHECK ("admitted_accounts"."email" = lower("admitted_accounts"."email")
        and "admitted_accounts"."email" = btrim("admitted_accounts"."email")
        and length("admitted_accounts"."email") between 3 and 320
        and "admitted_accounts"."email" ~ '^[^[:space:]@]+@[^[:space:]@]+$'),
	CONSTRAINT "admitted_accounts_revocation_complete" CHECK (("admitted_accounts"."revoked_at" is null) = ("admitted_accounts"."revoked_by_user_id" is null)),
	CONSTRAINT "admitted_accounts_revoked_after_admission" CHECK ("admitted_accounts"."revoked_at" is null or "admitted_accounts"."revoked_at" >= "admitted_accounts"."admitted_at")
);
--> statement-breakpoint
ALTER TABLE "admitted_accounts" ADD CONSTRAINT "admitted_accounts_admitted_by_user_id_users_id_fk" FOREIGN KEY ("admitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admitted_accounts" ADD CONSTRAINT "admitted_accounts_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admitted_accounts_active_email_uq" ON "admitted_accounts" USING btree ("email") WHERE "admitted_accounts"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "admitted_accounts_email_idx" ON "admitted_accounts" USING btree ("email");--> statement-breakpoint
-- Grants the application role what it needs on "admitted_accounts". The
-- blanket application-role grant ran before this table existed, and
-- PostgreSQL does not apply an earlier GRANT ... ON ALL TABLES to a table
-- created later, so sign-in (which reads admissions) and the Access page
-- (which writes them) would otherwise be refused.
GRANT SELECT ON TABLE public."admitted_accounts" TO "psd_eoc_app";--> statement-breakpoint
GRANT INSERT (
  "id", "email", "note", "admitted_at", "admitted_by_user_id"
) ON TABLE public."admitted_accounts" TO "psd_eoc_app";--> statement-breakpoint
-- Revocation is the only change ever made to a row; the address, note, and
-- admission facts stay as written. No DELETE is granted, and none should be:
-- a revoked admission is the record of who was let in and when it ended.
GRANT UPDATE ("revoked_at", "revoked_by_user_id")
ON TABLE public."admitted_accounts" TO "psd_eoc_app";
