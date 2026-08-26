CREATE TABLE "expo_push_provider_io" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"work_fingerprint" varchar(64) NOT NULL,
	"claim_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"completion" jsonb,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "expo_push_provider_io_completion_pairing" CHECK (("expo_push_provider_io"."completion" is null) = ("expo_push_provider_io"."completed_at" is null)),
	CONSTRAINT "expo_push_provider_io_completion_object" CHECK ("expo_push_provider_io"."completion" is null or jsonb_typeof("expo_push_provider_io"."completion") = 'object')
);
--> statement-breakpoint
CREATE TABLE "expo_push_receipt_polls" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"receipt_id" varchar(500) NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"target" jsonb NOT NULL,
	"first_poll_at" timestamp with time zone NOT NULL,
	"horizon_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"poll_attempt_number" integer DEFAULT 1 NOT NULL,
	"last_reason_code" varchar(100),
	"receipt_reference_state" varchar(16) DEFAULT 'unique' NOT NULL,
	"pending_action" jsonb,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_decision" jsonb,
	"terminal_decision" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expo_push_receipt_polls_window" CHECK ("expo_push_receipt_polls"."first_poll_at" <= "expo_push_receipt_polls"."due_at"
        and "expo_push_receipt_polls"."due_at" <= "expo_push_receipt_polls"."horizon_at"),
	CONSTRAINT "expo_push_receipt_polls_attempt_positive" CHECK ("expo_push_receipt_polls"."poll_attempt_number" between 1 and 10000),
	CONSTRAINT "expo_push_receipt_polls_reference_state" CHECK ("expo_push_receipt_polls"."receipt_reference_state" in ('unique', 'conflict')),
	CONSTRAINT "expo_push_receipt_polls_lease_pairing" CHECK (("expo_push_receipt_polls"."lease_token" is null) = ("expo_push_receipt_polls"."lease_expires_at" is null)),
	CONSTRAINT "expo_push_receipt_polls_json_objects" CHECK (jsonb_typeof("expo_push_receipt_polls"."target") = 'object'
        and ("expo_push_receipt_polls"."pending_action" is null or jsonb_typeof("expo_push_receipt_polls"."pending_action") = 'object')
        and ("expo_push_receipt_polls"."last_decision" is null or jsonb_typeof("expo_push_receipt_polls"."last_decision") = 'object')
        and ("expo_push_receipt_polls"."terminal_decision" is null or jsonb_typeof("expo_push_receipt_polls"."terminal_decision") = 'object'))
);
--> statement-breakpoint
CREATE TABLE "expo_push_retry_schedules" (
	"source_attempt_id" uuid PRIMARY KEY NOT NULL,
	"source_fingerprint" varchar(64) NOT NULL,
	"receipt_id" varchar(500),
	"next_attempt_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"next_attempt_number" integer NOT NULL,
	"delay_milliseconds" integer NOT NULL,
	"retry_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"reason_code" varchar(100) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expo_push_retry_schedules_next_attempt_uq" UNIQUE("next_attempt_id"),
	CONSTRAINT "expo_push_retry_schedules_attempt_positive" CHECK ("expo_push_retry_schedules"."next_attempt_number" between 2 and 10),
	CONSTRAINT "expo_push_retry_schedules_delay" CHECK ("expo_push_retry_schedules"."delay_milliseconds" between 1 and 3600000),
	CONSTRAINT "expo_push_retry_schedules_window" CHECK ("expo_push_retry_schedules"."retry_at" < "expo_push_retry_schedules"."expires_at"),
	CONSTRAINT "expo_push_retry_schedules_receipt_reason" CHECK ("expo_push_retry_schedules"."receipt_id" is null
        or "expo_push_retry_schedules"."reason_code" = 'EXPO_MESSAGE_RATE_EXCEEDED')
);
--> statement-breakpoint
ALTER TABLE "device_push_token_registrations" ADD COLUMN "provider" varchar(32) DEFAULT 'expo' NOT NULL;--> statement-breakpoint
ALTER TABLE "device_push_token_registrations" ADD COLUMN "application_id" varchar(255);--> statement-breakpoint
ALTER TABLE "device_push_token_registrations" ADD COLUMN "application_version" varchar(64);--> statement-breakpoint
ALTER TABLE "device_push_token_registrations" ADD COLUMN "native_build_version" varchar(32);--> statement-breakpoint
ALTER TABLE "device_push_token_registrations" ADD COLUMN "expo_project_id" uuid;--> statement-breakpoint
ALTER TABLE "device_push_token_registrations" ADD COLUMN "update_mode" varchar(32);--> statement-breakpoint
ALTER TABLE "expo_push_provider_io" ADD CONSTRAINT "expo_push_provider_io_attempt_id_channel_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."channel_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expo_push_receipt_polls" ADD CONSTRAINT "expo_push_receipt_polls_attempt_id_channel_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."channel_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expo_push_retry_schedules" ADD CONSTRAINT "expo_push_retry_schedules_source_attempt_id_channel_attempts_id_fk" FOREIGN KEY ("source_attempt_id") REFERENCES "public"."channel_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expo_push_receipt_polls_due_idx" ON "expo_push_receipt_polls" USING btree ("due_at","attempt_id") WHERE "expo_push_receipt_polls"."terminal_decision" is null;--> statement-breakpoint
CREATE INDEX "expo_push_receipt_polls_receipt_idx" ON "expo_push_receipt_polls" USING btree ("receipt_id","attempt_id");--> statement-breakpoint
CREATE INDEX "expo_push_retry_schedules_retry_at_idx" ON "expo_push_retry_schedules" USING btree ("retry_at");--> statement-breakpoint
ALTER TABLE "device_push_token_registrations" ADD CONSTRAINT "device_push_token_registrations_expo_only" CHECK ("device_push_token_registrations"."provider" = 'expo');--> statement-breakpoint
ALTER TABLE "device_push_token_registrations" ADD CONSTRAINT "device_push_token_registrations_application_id_format" CHECK ("device_push_token_registrations"."application_id" ~ '^[A-Za-z0-9]+([._-][A-Za-z0-9]+)+$');--> statement-breakpoint
ALTER TABLE "device_push_token_registrations" ADD CONSTRAINT "device_push_token_registrations_application_version_format" CHECK ("device_push_token_registrations"."application_version" ~ '^[0-9]+[.][0-9]+[.][0-9]+$');--> statement-breakpoint
ALTER TABLE "device_push_token_registrations" ADD CONSTRAINT "device_push_token_registrations_native_build_version_format" CHECK ("device_push_token_registrations"."native_build_version" ~ '^[1-9][0-9]{0,17}$');--> statement-breakpoint
ALTER TABLE "device_push_token_registrations" ADD CONSTRAINT "device_push_token_registrations_embedded_only" CHECK ("device_push_token_registrations"."update_mode" = 'embedded-only');--> statement-breakpoint
ALTER TABLE "device_push_token_registrations" ADD CONSTRAINT "device_push_token_registrations_build_identity_pairing" CHECK (num_nonnulls(
          "device_push_token_registrations"."application_id",
          "device_push_token_registrations"."application_version",
          "device_push_token_registrations"."native_build_version",
          "device_push_token_registrations"."expo_project_id",
          "device_push_token_registrations"."update_mode"
        ) in (0, 5));