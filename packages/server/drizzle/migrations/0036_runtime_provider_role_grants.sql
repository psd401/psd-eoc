-- Migrations 0031 and 0032 created the Expo and SMS provider-runtime tables
-- after the initial blanket application-role grant. PostgreSQL does not apply
-- an earlier GRANT ... ON ALL TABLES to tables created later, so the live
-- workers could authenticate but could not read or claim their durable state.
-- Revoke first so this migration is a complete least-privilege definition.
CREATE FUNCTION public."psd_eoc_guard_provider_io_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	IF TG_RELID NOT IN (
		'public.expo_push_provider_io'::pg_catalog.regclass,
		'public.sms_provider_io'::pg_catalog.regclass
	) OR TG_LEVEL <> 'ROW' OR TG_OP NOT IN ('UPDATE', 'DELETE') THEN
		RAISE EXCEPTION 'Unexpected provider I/O mutation guard context';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'Provider I/O truth is append-only';
	END IF;
	IF OLD."completion" IS NOT NULL
		OR NEW."attempt_id" IS DISTINCT FROM OLD."attempt_id"
		OR NEW."work_fingerprint" IS DISTINCT FROM OLD."work_fingerprint"
		OR NEW."claim_token" IS DISTINCT FROM OLD."claim_token"
		OR NEW."claimed_at" IS DISTINCT FROM OLD."claimed_at"
		OR NEW."completion" IS NULL
		OR NEW."completed_at" IS NULL THEN
		RAISE EXCEPTION 'Provider I/O truth is append-only';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "expo_push_provider_io_append_only"
BEFORE UPDATE OR DELETE ON public."expo_push_provider_io"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_guard_provider_io_mutation"();
--> statement-breakpoint
CREATE TRIGGER "sms_provider_io_append_only"
BEFORE UPDATE OR DELETE ON public."sms_provider_io"
FOR EACH ROW EXECUTE FUNCTION public."psd_eoc_guard_provider_io_mutation"();
--> statement-breakpoint
REVOKE ALL ON FUNCTION public."psd_eoc_guard_provider_io_mutation"()
FROM PUBLIC, "psd_eoc_app";
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE
	public."expo_push_provider_io",
	public."expo_push_receipt_polls",
	public."expo_push_retry_schedules",
	public."sms_provider_io",
	public."sms_retry_schedules"
FROM PUBLIC, "psd_eoc_app";
--> statement-breakpoint
GRANT SELECT ON TABLE
	public."expo_push_provider_io",
	public."expo_push_receipt_polls",
	public."expo_push_retry_schedules",
	public."sms_provider_io",
	public."sms_retry_schedules"
TO "psd_eoc_app";
--> statement-breakpoint
GRANT INSERT ("attempt_id", "work_fingerprint")
ON TABLE public."expo_push_provider_io"
TO "psd_eoc_app";
--> statement-breakpoint
GRANT INSERT (
	"attempt_id",
	"receipt_id",
	"fingerprint",
	"target",
	"first_poll_at",
	"horizon_at",
	"due_at"
)
ON TABLE public."expo_push_receipt_polls"
TO "psd_eoc_app";
--> statement-breakpoint
GRANT INSERT (
	"source_attempt_id",
	"source_fingerprint",
	"receipt_id",
	"next_attempt_number",
	"delay_milliseconds",
	"retry_at",
	"expires_at",
	"reason_code"
)
ON TABLE public."expo_push_retry_schedules"
TO "psd_eoc_app";
--> statement-breakpoint
GRANT INSERT ("attempt_id", "work_fingerprint")
ON TABLE public."sms_provider_io"
TO "psd_eoc_app";
--> statement-breakpoint
GRANT INSERT (
	"source_attempt_id",
	"source_fingerprint",
	"next_attempt_number",
	"delay_milliseconds",
	"retry_at",
	"expires_at",
	"reason_code"
)
ON TABLE public."sms_retry_schedules"
TO "psd_eoc_app";
--> statement-breakpoint
GRANT UPDATE ("completion", "completed_at")
ON TABLE public."expo_push_provider_io"
TO "psd_eoc_app";
--> statement-breakpoint
GRANT UPDATE (
	"receipt_reference_state",
	"pending_action",
	"lease_token",
	"lease_expires_at",
	"due_at",
	"poll_attempt_number",
	"last_reason_code",
	"last_decision",
	"terminal_decision",
	"updated_at"
)
ON TABLE public."expo_push_receipt_polls"
TO "psd_eoc_app";
--> statement-breakpoint
GRANT UPDATE ("completion", "completed_at")
ON TABLE public."sms_provider_io"
TO "psd_eoc_app";
