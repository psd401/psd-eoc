ALTER TABLE "endpoint_status_records" DROP CONSTRAINT "endpoint_status_records_terminal_status";--> statement-breakpoint
ALTER TABLE "endpoint_status_records" ADD COLUMN "sequence" integer NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "endpoint_status_records_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1);--> statement-breakpoint
REVOKE ALL PRIVILEGES ON SEQUENCE public."endpoint_status_records_sequence_seq" FROM PUBLIC, "psd_eoc_app";--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE public."endpoint_status_records_sequence_seq" TO "psd_eoc_app";--> statement-breakpoint
REVOKE UPDATE ON SEQUENCE public."endpoint_status_records_sequence_seq" FROM "psd_eoc_app";--> statement-breakpoint
ALTER TABLE "endpoint_status_records" ADD COLUMN "provider" varchar(100);--> statement-breakpoint
ALTER TABLE "endpoint_status_records" ADD COLUMN "provider_reference" varchar(500);--> statement-breakpoint
ALTER TABLE "endpoint_status_records" ADD COLUMN "provider_occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sms_opt_out_records" ADD COLUMN "provider_occurred_at" timestamp with time zone;--> statement-breakpoint
-- Preserve immutable legacy status rows. Append one canonical provider fact
-- for each endpoint whose retained opt-out record proves the old status.
INSERT INTO "endpoint_status_records" (
	"id",
	"roster_snapshot_id",
	"recipient_id",
	"endpoint_id",
	"population",
	"channel",
	"status",
	"reason_code",
	"provider",
	"provider_reference",
	"provider_occurred_at",
	"recorded_at"
)
SELECT
	gen_random_uuid(),
	"status"."roster_snapshot_id",
	"status"."recipient_id",
	"status"."endpoint_id",
	"status"."population",
	'sms',
	'disabled',
	'SMS_OPTED_OUT',
	"opt_out"."provider",
	"opt_out"."provider_reference",
	"opt_out"."recorded_at",
	clock_timestamp()
FROM (
	SELECT DISTINCT ON (
		"roster_snapshot_id",
		"recipient_id",
		"endpoint_id"
	)
		"roster_snapshot_id",
		"recipient_id",
		"endpoint_id",
		"population"
	FROM "endpoint_status_records"
	WHERE
		"channel" = 'sms'
		AND "status" = 'disabled'
		AND "reason_code" = 'SMS_OPTED_OUT'
	ORDER BY
		"roster_snapshot_id",
		"recipient_id",
		"endpoint_id",
		"recorded_at" DESC,
		"id" DESC
) AS "status"
JOIN (
	SELECT DISTINCT ON (
		"roster_snapshot_id",
		"recipient_id",
		"endpoint_id"
	)
		"roster_snapshot_id",
		"recipient_id",
		"endpoint_id",
		"provider",
		"provider_reference",
		"recorded_at"
	FROM "sms_opt_out_records"
	WHERE
		"provider" = 'aws-eum-sms'
		AND "provider_reference" = btrim("provider_reference")
		AND length("provider_reference") BETWEEN 1 AND 500
	ORDER BY
		"roster_snapshot_id",
		"recipient_id",
		"endpoint_id",
		"recorded_at" DESC,
		"id" DESC
) AS "opt_out"
ON
	"status"."roster_snapshot_id" = "opt_out"."roster_snapshot_id"
	AND "status"."recipient_id" = "opt_out"."recipient_id"
	AND "status"."endpoint_id" = "opt_out"."endpoint_id";--> statement-breakpoint
CREATE UNIQUE INDEX "endpoint_status_records_sequence_uq" ON "endpoint_status_records" USING btree ("sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "endpoint_status_records_provider_reference_uq" ON "endpoint_status_records" USING btree ("roster_snapshot_id","recipient_id","endpoint_id","provider","provider_reference");--> statement-breakpoint
CREATE INDEX "endpoint_status_records_latest_idx" ON "endpoint_status_records" USING btree ("roster_snapshot_id","recipient_id","endpoint_id","sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "endpoint_status_records_sms_lifecycle_idx" ON "endpoint_status_records" USING btree ("roster_snapshot_id","recipient_id","endpoint_id","provider_occurred_at" DESC NULLS LAST,"sequence" DESC NULLS LAST) WHERE "endpoint_status_records"."channel" = 'sms' and "endpoint_status_records"."reason_code" in ('SMS_OPTED_OUT', 'SMS_OPT_IN_PROVIDER_VERIFIED');--> statement-breakpoint
CREATE INDEX "roster_endpoints_sms_phone_idx" ON "roster_endpoints" USING btree ("phone_number") WHERE "roster_endpoints"."channel" = 'sms' and "roster_endpoints"."phone_number" is not null;--> statement-breakpoint
ALTER TABLE "endpoint_status_records" ADD CONSTRAINT "endpoint_status_records_lifecycle_status" CHECK ("endpoint_status_records"."status" in ('active', 'invalid', 'disabled'));--> statement-breakpoint
ALTER TABLE "endpoint_status_records" ADD CONSTRAINT "endpoint_status_records_provider_identity" CHECK (("endpoint_status_records"."provider" is null) = ("endpoint_status_records"."provider_reference" is null)
        and ("endpoint_status_records"."provider" is null) = ("endpoint_status_records"."provider_occurred_at" is null)
        and ("endpoint_status_records"."provider" is null or (
          "endpoint_status_records"."channel" = 'sms'
          and "endpoint_status_records"."provider" = 'aws-eum-sms'
          and (
            ("endpoint_status_records"."status" = 'active' and "endpoint_status_records"."reason_code" = 'SMS_OPT_IN_PROVIDER_VERIFIED')
            or ("endpoint_status_records"."status" = 'disabled' and "endpoint_status_records"."reason_code" = 'SMS_OPTED_OUT')
          )
        )));--> statement-breakpoint
ALTER TABLE "endpoint_status_records" ADD CONSTRAINT "endpoint_status_records_provider_format" CHECK ("endpoint_status_records"."provider" is null or (
        "endpoint_status_records"."provider" = btrim("endpoint_status_records"."provider")
        and "endpoint_status_records"."provider_reference" = btrim("endpoint_status_records"."provider_reference")
        and length("endpoint_status_records"."provider") between 1 and 100
        and length("endpoint_status_records"."provider_reference") between 1 and 500
      ));--> statement-breakpoint
ALTER TABLE "endpoint_status_records" ADD CONSTRAINT "endpoint_status_records_verified_active" CHECK (("endpoint_status_records"."status" = 'active') = (
        "endpoint_status_records"."channel" = 'sms'
        and "endpoint_status_records"."reason_code" = 'SMS_OPT_IN_PROVIDER_VERIFIED'
        and "endpoint_status_records"."provider" = 'aws-eum-sms'
        and "endpoint_status_records"."provider_reference" is not null
        and "endpoint_status_records"."provider_occurred_at" is not null
      ));--> statement-breakpoint
-- NOT VALID preserves grandfathered immutable rows while enforcing the
-- canonical shape for every future insert. A fresh/canonical database is
-- validated immediately below.
ALTER TABLE "endpoint_status_records" ADD CONSTRAINT "endpoint_status_records_managed_sms_opt_out" CHECK (("endpoint_status_records"."reason_code" = 'SMS_OPTED_OUT') = (
        "endpoint_status_records"."channel" = 'sms'
        and "endpoint_status_records"."status" = 'disabled'
        and "endpoint_status_records"."provider" = 'aws-eum-sms'
        and "endpoint_status_records"."provider_reference" is not null
        and "endpoint_status_records"."provider_occurred_at" is not null
      )) NOT VALID;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM "endpoint_status_records"
		WHERE ("reason_code" = 'SMS_OPTED_OUT') IS DISTINCT FROM (
			"channel" = 'sms'
			AND "status" = 'disabled'
			AND "provider" = 'aws-eum-sms'
			AND "provider_reference" IS NOT NULL
			AND "provider_occurred_at" IS NOT NULL
		)
	) THEN
		ALTER TABLE "endpoint_status_records"
			VALIDATE CONSTRAINT "endpoint_status_records_managed_sms_opt_out";
	END IF;
END;
$$;--> statement-breakpoint
ALTER TABLE "endpoint_status_records" ADD CONSTRAINT "endpoint_status_records_provider_time" CHECK ("endpoint_status_records"."provider_occurred_at" is null
        or "endpoint_status_records"."provider_occurred_at" <= "endpoint_status_records"."recorded_at" + interval '5 minutes');--> statement-breakpoint
-- Legacy opt-out rows keep an unknown provider occurrence rather than
-- inventing one by rewriting history. NOT VALID still rejects null on every
-- new insert; a fresh database validates the invariant immediately.
ALTER TABLE "sms_opt_out_records" ADD CONSTRAINT "sms_opt_out_records_provider_time_required" CHECK ("sms_opt_out_records"."provider_occurred_at" is not null) NOT VALID;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM "sms_opt_out_records"
		WHERE "provider_occurred_at" IS NULL
	) THEN
		ALTER TABLE "sms_opt_out_records"
			VALIDATE CONSTRAINT "sms_opt_out_records_provider_time_required";
	END IF;
END;
$$;--> statement-breakpoint
ALTER TABLE "sms_opt_out_records" ADD CONSTRAINT "sms_opt_out_records_provider_time" CHECK ("sms_opt_out_records"."provider_occurred_at" is null
        or "sms_opt_out_records"."provider_occurred_at" <= "sms_opt_out_records"."recorded_at" + interval '5 minutes');
