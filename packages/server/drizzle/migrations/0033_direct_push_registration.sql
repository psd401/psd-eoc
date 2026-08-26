ALTER TABLE "device_push_token_registrations" DROP CONSTRAINT "device_push_token_registrations_expo_only";--> statement-breakpoint
ALTER TABLE "roster_endpoints" DROP CONSTRAINT "roster_endpoints_valid_variant";--> statement-breakpoint
ALTER TABLE "dispatch_batches" DROP CONSTRAINT "dispatch_batches_integration_channel";--> statement-breakpoint
ALTER TABLE "notification_intent_channels" DROP CONSTRAINT "notification_intent_channels_integration_channel";--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_channel_plan_shape";--> statement-breakpoint
ALTER TABLE "device_push_token_registrations" ADD COLUMN "service_environment" varchar(32) DEFAULT 'production' NOT NULL;--> statement-breakpoint
ALTER TABLE "device_push_token_registrations" ADD COLUMN "supersedes_registration_id" uuid;--> statement-breakpoint
ALTER TABLE "roster_endpoints" ADD COLUMN "provider" varchar(32);--> statement-breakpoint
ALTER TABLE "roster_endpoints" ADD COLUMN "service_environment" varchar(32);--> statement-breakpoint
ALTER TABLE "delivery_evidence" ADD COLUMN "provider_occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "roster_endpoints" DISABLE TRIGGER "roster_endpoints_immutable_guard";--> statement-breakpoint
UPDATE "roster_endpoints"
SET
	"provider" = 'expo',
	"service_environment" = 'production'
WHERE "channel" = 'push';--> statement-breakpoint
ALTER TABLE "roster_endpoints" ENABLE TRIGGER "roster_endpoints_immutable_guard";--> statement-breakpoint
ALTER TABLE "device_push_token_registrations" ADD CONSTRAINT "device_push_token_registrations_supersedes_device_fk" FOREIGN KEY ("supersedes_registration_id","device_enrollment_id") REFERENCES "public"."device_push_token_registrations"("id","device_enrollment_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_push_token_registrations" ADD CONSTRAINT "device_push_token_registrations_supersedes_uq" UNIQUE("supersedes_registration_id");--> statement-breakpoint
ALTER TABLE "device_push_token_registrations" ADD CONSTRAINT "device_push_token_registrations_provider" CHECK ("device_push_token_registrations"."provider" in ('expo', 'apns', 'fcm'));--> statement-breakpoint
ALTER TABLE "device_push_token_registrations" ADD CONSTRAINT "device_push_token_registrations_service_environment" CHECK ("device_push_token_registrations"."service_environment" in ('development', 'production'));--> statement-breakpoint
ALTER TABLE "device_push_token_registrations" ADD CONSTRAINT "device_push_token_registrations_provider_platform" CHECK ("device_push_token_registrations"."provider" = 'expo'
        or ("device_push_token_registrations"."provider" = 'apns' and "device_push_token_registrations"."platform" = 'ios')
        or ("device_push_token_registrations"."provider" = 'fcm' and "device_push_token_registrations"."platform" = 'android'));--> statement-breakpoint
ALTER TABLE "device_push_token_registrations" ADD CONSTRAINT "device_push_token_registrations_not_self_superseding" CHECK ("device_push_token_registrations"."supersedes_registration_id" is null
        or "device_push_token_registrations"."supersedes_registration_id" <> "device_push_token_registrations"."id");--> statement-breakpoint
ALTER TABLE "delivery_evidence" ADD CONSTRAINT "delivery_evidence_provider_time" CHECK ("delivery_evidence"."provider_occurred_at" is null
        or "delivery_evidence"."provider_occurred_at" <= "delivery_evidence"."recorded_at" + interval '5 minutes');--> statement-breakpoint
ALTER TABLE "delivery_evidence" ADD CONSTRAINT "delivery_evidence_apns_unregistered_time" CHECK ((
        "delivery_evidence"."reason_code" is distinct from 'APNS_UNREGISTERED'
        and "delivery_evidence"."provider_occurred_at" is null
      ) or (
        "delivery_evidence"."state" = 'failed'
        and "delivery_evidence"."provider" = 'apns-direct'
        and "delivery_evidence"."reason_code" = 'APNS_UNREGISTERED'
        and "delivery_evidence"."provider_occurred_at" is not null
      ));--> statement-breakpoint
WITH latest_expo_status AS (
	SELECT DISTINCT ON ("integration_id")
		"label",
		"reason_code",
		"observed_at"
	FROM "integration_statuses"
	WHERE "integration_id" = 'expo-push'
	ORDER BY "integration_id", "observed_at" DESC, "id" DESC
)
INSERT INTO "integration_statuses" (
	"id",
	"integration_id",
	"label",
	"verified_at",
	"verified_by_user_id",
	"authorization_reference",
	"reason_code",
	"observed_at"
)
SELECT
	gen_random_uuid(),
	'mobile-push',
	case when "label" = 'live-verified' then 'configured-unverified' else "label" end,
	null,
	null,
	null,
	case when "label" = 'blocked' then "reason_code" else null end,
	"observed_at"
FROM latest_expo_status
WHERE NOT EXISTS (
	SELECT 1 FROM "integration_statuses" WHERE "integration_id" = 'mobile-push'
);--> statement-breakpoint
INSERT INTO "channel_configurations" (
	"integration_id",
	"enabled",
	"status_id",
	"status_label",
	"changed_at"
)
SELECT
	'mobile-push',
	false,
	mobile_status."id",
	mobile_status."label",
	GREATEST(expo_configuration."changed_at", mobile_status."observed_at")
FROM "channel_configurations" AS expo_configuration
CROSS JOIN LATERAL (
	SELECT "id", "label", "observed_at"
	FROM "integration_statuses"
	WHERE "integration_id" = 'mobile-push'
	ORDER BY "observed_at" DESC, "id" DESC
	LIMIT 1
) AS mobile_status
WHERE expo_configuration."integration_id" = 'expo-push'
ON CONFLICT ("integration_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "roster_endpoints" ADD CONSTRAINT "roster_endpoints_valid_variant" CHECK ((
        "roster_endpoints"."channel" = 'push'
        and "roster_endpoints"."platform" is not null
        and "roster_endpoints"."provider" in ('expo', 'apns', 'fcm')
        and "roster_endpoints"."service_environment" in ('development', 'production')
        and (
          "roster_endpoints"."provider" = 'expo'
          or ("roster_endpoints"."provider" = 'apns' and "roster_endpoints"."platform" = 'ios')
          or ("roster_endpoints"."provider" = 'fcm' and "roster_endpoints"."platform" = 'android')
        )
        and "roster_endpoints"."token" is not null
        and length(btrim("roster_endpoints"."token")) between 16 and 4096
        and "roster_endpoints"."email" is null
        and "roster_endpoints"."phone_number" is null
      ) or (
        "roster_endpoints"."channel" = 'email'
        and "roster_endpoints"."platform" is null
        and "roster_endpoints"."provider" is null
        and "roster_endpoints"."service_environment" is null
        and "roster_endpoints"."token" is null
        and "roster_endpoints"."email" is not null
        and "roster_endpoints"."phone_number" is null
      ) or (
        "roster_endpoints"."channel" = 'sms'
        and "roster_endpoints"."platform" is null
        and "roster_endpoints"."provider" is null
        and "roster_endpoints"."service_environment" is null
        and "roster_endpoints"."token" is null
        and "roster_endpoints"."email" is null
        and "roster_endpoints"."phone_number" is not null
        and "roster_endpoints"."phone_number" ~ '^\+[1-9][0-9]{7,14}$'
      ));--> statement-breakpoint
ALTER TABLE "dispatch_batches" ADD CONSTRAINT "dispatch_batches_integration_channel" CHECK ((
        "dispatch_batches"."channel" = 'push'
        and "dispatch_batches"."integration_id" in ('expo-push', 'mobile-push')
      ) or (
        "dispatch_batches"."channel" = 'email' and "dispatch_batches"."integration_id" = 'ses-email'
      ) or (
        "dispatch_batches"."channel" = 'sms' and "dispatch_batches"."integration_id" = 'aws-eum-sms'
      ));--> statement-breakpoint
ALTER TABLE "notification_intent_channels" ADD CONSTRAINT "notification_intent_channels_integration_channel" CHECK ((
        "notification_intent_channels"."channel" = 'push'
        and "notification_intent_channels"."integration_id" in ('expo-push', 'mobile-push')
      ) or (
        "notification_intent_channels"."channel" = 'email' and "notification_intent_channels"."integration_id" = 'ses-email'
      ) or (
        "notification_intent_channels"."channel" = 'sms' and "notification_intent_channels"."integration_id" = 'aws-eum-sms'
      ));--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_channel_plan_shape" CHECK (case
        when jsonb_typeof("outbox"."channels") = 'array' then
          (
            (
              jsonb_array_length("outbox"."channels") between 2 and 3
              and jsonb_array_length(jsonb_path_query_array(
                "outbox"."channels", '$[*] ? (@.channel == "push" && @.renderedMessage.channel == "push" && (@.integrationStatus.integrationId == "expo-push" || @.integrationStatus.integrationId == "mobile-push"))'
              )) = 1
              and jsonb_array_length(jsonb_path_query_array(
                "outbox"."channels", '$[*] ? (@.channel == "email" && @.renderedMessage.channel == "email" && @.integrationStatus.integrationId == "ses-email")'
              )) = 1
              and jsonb_array_length(jsonb_path_query_array(
                "outbox"."channels", '$[*] ? (@.channel == "sms" && @.renderedMessage.channel == "sms" && @.integrationStatus.integrationId == "aws-eum-sms")'
              )) <= 1
            ) or (
              "outbox"."event_kind" = 'drill'
              and "outbox"."template_mode" = 'drill'
              and "outbox"."purpose" = 'activation'
              and "outbox"."roster_population" = 'staff'
              and jsonb_typeof("outbox"."message" -> 'deliveryTest') is not distinct from 'object'
              and jsonb_array_length("outbox"."channels") = 1
              and jsonb_array_length(jsonb_path_query_array(
                "outbox"."channels", '$[*] ? (@.channel == "sms" && @.renderedMessage.channel == "sms" && @.integrationStatus.integrationId == "aws-eum-sms")'
              )) = 1
            )
          ) and jsonb_array_length(jsonb_path_query_array(
            "outbox"."channels", '$[*] ? (@.channel == "push" || @.channel == "email" || @.channel == "sms")'
          )) = jsonb_array_length("outbox"."channels")
        else false
      end) NOT VALID;
