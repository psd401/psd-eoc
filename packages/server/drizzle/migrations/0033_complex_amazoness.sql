ALTER TYPE "public"."mutation_capability" ADD VALUE IF NOT EXISTS 'verify-email-integration' BEFORE 'issue-agent-api-key';--> statement-breakpoint
CREATE TABLE "ses_email_provider_io" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"request_fingerprint" varchar(64) NOT NULL,
	"claim_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"outcome" jsonb,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ses_email_provider_io_completion_pairing" CHECK (("ses_email_provider_io"."outcome" is null) = ("ses_email_provider_io"."completed_at" is null)),
	CONSTRAINT "ses_email_provider_io_outcome_object" CHECK ("ses_email_provider_io"."outcome" is null or jsonb_typeof("ses_email_provider_io"."outcome") = 'object')
);
--> statement-breakpoint
ALTER TABLE "ses_email_provider_io" ADD CONSTRAINT "ses_email_provider_io_attempt_id_channel_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."channel_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION public."psd_eoc_guard_ses_email_provider_io_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'SES provider I/O truth is append-only';
	END IF;
	IF OLD."outcome" IS NOT NULL
		OR NEW."attempt_id" IS DISTINCT FROM OLD."attempt_id"
		OR NEW."request_fingerprint" IS DISTINCT FROM OLD."request_fingerprint"
		OR NEW."claim_token" IS DISTINCT FROM OLD."claim_token"
		OR NEW."claimed_at" IS DISTINCT FROM OLD."claimed_at"
		OR NEW."outcome" IS NULL
		OR NEW."completed_at" IS NULL THEN
		RAISE EXCEPTION 'SES provider I/O truth is append-only';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "ses_email_provider_io_append_only"
BEFORE UPDATE OR DELETE ON "ses_email_provider_io"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_guard_ses_email_provider_io_mutation"();--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_guard_ses_email_provider_io_mutation"()
FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public."ses_email_provider_io"
FROM "psd_eoc_app";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public."ses_email_provider_io"
TO "psd_eoc_app";--> statement-breakpoint
GRANT UPDATE ("outcome", "completed_at") ON TABLE public."ses_email_provider_io"
TO "psd_eoc_app";
