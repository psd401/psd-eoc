CREATE TABLE "partner_access_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quarter" varchar(7) NOT NULL,
	"never_signed_in_count" integer NOT NULL,
	"inactive_count" integer NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_access_reviews_quarter_format" CHECK ("partner_access_reviews"."quarter" ~ '^[0-9]{4}-Q[1-4]$'),
	CONSTRAINT "partner_access_reviews_counts" CHECK ("partner_access_reviews"."never_signed_in_count" >= 0 and "partner_access_reviews"."inactive_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "partner_access_reviews_quarter_uq" ON "partner_access_reviews" USING btree ("quarter");--> statement-breakpoint
-- A sent review is a record and is never changed.
CREATE TRIGGER "partner_access_reviews_append_only"
BEFORE UPDATE OR DELETE ON public."partner_access_reviews"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_reject_partner_admission_mutation"();--> statement-breakpoint
GRANT SELECT ON TABLE public."partner_access_reviews" TO "psd_eoc_app";--> statement-breakpoint
GRANT INSERT (
  "id", "quarter", "never_signed_in_count", "inactive_count", "sent_at"
) ON TABLE public."partner_access_reviews" TO "psd_eoc_app";
