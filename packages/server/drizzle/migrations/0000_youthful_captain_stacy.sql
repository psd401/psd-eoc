CREATE TYPE "public"."actor_kind" AS ENUM('human', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."agent_capability_grant" AS ENUM('sync-roster', 'prepare-activation', 'start-event', 'join-event', 'all-clear-event', 'reactivate-event', 'close-event', 'reopen-as-correction', 'append-journal-entry', 'correct-journal-entry', 'redact-journal-entry', 'create-media-upload-intent', 'complete-media-upload', 'create-event-type-draft', 'update-event-type-draft', 'publish-event-type-version', 'create-facility', 'update-facility', 'create-neighborhood-version', 'create-audience-config-version', 'create-group-source', 'update-group-source', 'set-channel-enabled', 'create-activation-preview', 'create-lifecycle-consequence-preview', 'get-prepared-activation', 'get-roster-snapshot', 'list-group-sources', 'get-roster-health', 'get-stale-roster-report', 'list-active-events', 'get-event', 'list-journal-entries', 'search-journal-entries', 'get-media-read-grant', 'list-event-types', 'get-event-type-version', 'get-event-type-draft', 'preview-event-type-rendering', 'get-notification-status', 'run-delivery-report', 'get-integration-health', 'list-facilities', 'get-facility', 'list-neighborhoods', 'list-neighborhood-versions', 'get-neighborhood-version', 'get-audience-config', 'get-audience-config-version', 'list-users', 'list-agent-api-keys', 'list-drill-records', 'export-drill-records', 'export-event-summary', 'query-security-audit', 'verify-security-audit-chain');--> statement-breakpoint
CREATE TYPE "public"."audience_target_kind" AS ENUM('building', 'neighborhood', 'others');--> statement-breakpoint
CREATE TYPE "public"."classification_marker" AS ENUM('INCIDENT', 'DRILL');--> statement-breakpoint
CREATE TYPE "public"."delivery_evidence_subject_kind" AS ENUM('intent', 'attempt');--> statement-breakpoint
CREATE TYPE "public"."delivery_truth_state" AS ENUM('accepted', 'recorded', 'attempted', 'provider-accepted', 'delivered', 'failed', 'expired', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."device_platform" AS ENUM('web', 'ios', 'android');--> statement-breakpoint
CREATE TYPE "public"."device_unlock_method" AS ENUM('secure-session-cookie', 'biometric');--> statement-breakpoint
CREATE TYPE "public"."endpoint_status" AS ENUM('active', 'invalid', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."event_kind" AS ENUM('incident', 'drill', 'test');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('draft', 'active', 'all-clear', 'closed');--> statement-breakpoint
CREATE TYPE "public"."event_transition_kind" AS ENUM('activate', 'all-clear', 'reactivate', 'close', 'reopen-as-correction');--> statement-breakpoint
CREATE TYPE "public"."facility_scope_kind" AS ENUM('district', 'facilities');--> statement-breakpoint
CREATE TYPE "public"."group_completion_kind" AS ENUM('expected', 'completed');--> statement-breakpoint
CREATE TYPE "public"."group_purpose" AS ENUM('access', 'building', 'others');--> statement-breakpoint
CREATE TYPE "public"."group_source_kind" AS ENUM('google-group', 'synthetic');--> statement-breakpoint
CREATE TYPE "public"."human_confirmation_status" AS ENUM('issued', 'consumed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."human_only_action" AS ENUM('start-real-incident', 'send-real-notification', 'all-clear', 'close-real-event');--> statement-breakpoint
CREATE TYPE "public"."idempotency_status" AS ENUM('in-progress', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."integration_truth_label" AS ENUM('mocked', 'configured-unverified', 'live-verified', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."invocation_source" AS ENUM('web', 'mobile', 'agent-rest', 'mcp', 'worker', 'scheduled-job', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."journal_entry_kind" AS ENUM('text', 'photo', 'location', 'system');--> statement-breakpoint
CREATE TYPE "public"."journal_supersession_kind" AS ENUM('correction', 'redaction');--> statement-breakpoint
CREATE TYPE "public"."media_content_type" AS ENUM('image/jpeg', 'image/png', 'image/webp', 'image/heic');--> statement-breakpoint
CREATE TYPE "public"."mutation_capability" AS ENUM('complete-oidc-sign-in', 'refresh-session', 'revoke-session', 'sync-roster', 'prepare-activation', 'start-event', 'join-event', 'append-journal-entry', 'correct-journal-entry', 'redact-journal-entry', 'all-clear-event', 'reactivate-event', 'close-event', 'reopen-as-correction', 'create-media-upload-intent', 'complete-media-upload', 'create-event-type-draft', 'update-event-type-draft', 'publish-event-type-version', 'dispatch-outbox', 'record-delivery-evidence', 'reconcile-delivery-attempts', 'record-endpoint-status', 'record-sms-opt-out', 'register-push-token', 'unregister-push-token', 'create-facility', 'update-facility', 'create-neighborhood-version', 'create-audience-config-version', 'create-group-source', 'update-group-source', 'set-user-roles', 'set-channel-enabled', 'issue-agent-api-key', 'revoke-agent-api-key');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('push', 'email', 'sms');--> statement-breakpoint
CREATE TYPE "public"."notification_purpose" AS ENUM('activation', 'all-clear', 'reactivation');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'processing', 'published', 'failed');--> statement-breakpoint
CREATE TYPE "public"."push_platform" AS ENUM('ios', 'android');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('staff', 'admin');--> statement-breakpoint
CREATE TYPE "public"."roster_population" AS ENUM('staff', 'synthetic');--> statement-breakpoint
CREATE TYPE "public"."roster_sync_outcome" AS ENUM('complete', 'failed', 'partial-rejected');--> statement-breakpoint
CREATE TYPE "public"."security_audit_category" AS ENUM('sign-in', 'access-denial', 'admin-change', 'agent-access', 'session-revocation', 'human-only-rejection', 'capability-execution', 'audit-query');--> statement-breakpoint
CREATE TYPE "public"."security_audit_outcome" AS ENUM('success', 'denied', 'failure');--> statement-breakpoint
CREATE TYPE "public"."template_mode" AS ENUM('real', 'drill');--> statement-breakpoint
CREATE TABLE "access_membership_member_facilities" (
	"snapshot_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	CONSTRAINT "access_membership_member_facilities_snapshot_id_user_id_facility_id_pk" PRIMARY KEY("snapshot_id","user_id","facility_id")
);
--> statement-breakpoint
CREATE TABLE "access_membership_member_groups" (
	"snapshot_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"group_source_id" uuid NOT NULL,
	"group_source_kind" "group_source_kind" NOT NULL,
	"group_purpose" "group_purpose" NOT NULL,
	CONSTRAINT "access_membership_member_groups_snapshot_id_user_id_group_source_id_pk" PRIMARY KEY("snapshot_id","user_id","group_source_id"),
	CONSTRAINT "access_membership_member_groups_access_only" CHECK ("access_membership_member_groups"."group_source_kind" = 'google-group'
        and "access_membership_member_groups"."group_purpose" = 'access')
);
--> statement-breakpoint
CREATE TABLE "access_membership_members" (
	"snapshot_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"google_subject" varchar(255) NOT NULL,
	"facility_scope_kind" "facility_scope_kind" NOT NULL,
	CONSTRAINT "access_membership_members_snapshot_id_user_id_pk" PRIMARY KEY("snapshot_id","user_id"),
	CONSTRAINT "access_membership_members_subject_uq" UNIQUE("snapshot_id","google_subject")
);
--> statement-breakpoint
CREATE TABLE "access_membership_snapshot_groups" (
	"snapshot_id" uuid NOT NULL,
	"group_source_id" uuid NOT NULL,
	"group_source_kind" "group_source_kind" NOT NULL,
	"group_purpose" "group_purpose" NOT NULL,
	"completion_kind" "group_completion_kind" NOT NULL,
	CONSTRAINT "access_membership_snapshot_groups_snapshot_id_group_source_id_completion_kind_pk" PRIMARY KEY("snapshot_id","group_source_id","completion_kind"),
	CONSTRAINT "access_membership_snapshot_groups_access_only" CHECK ("access_membership_snapshot_groups"."group_source_kind" = 'google-group'
        and "access_membership_snapshot_groups"."group_purpose" = 'access')
);
--> statement-breakpoint
CREATE TABLE "access_membership_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"complete" boolean NOT NULL,
	"sync_started_at" timestamp with time zone NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	CONSTRAINT "access_membership_snapshots_version_uq" UNIQUE("version"),
	CONSTRAINT "access_membership_snapshots_complete_true" CHECK ("access_membership_snapshots"."complete" = true),
	CONSTRAINT "access_membership_snapshots_version_positive" CHECK ("access_membership_snapshots"."version" > 0),
	CONSTRAINT "access_membership_snapshots_times" CHECK ("access_membership_snapshots"."captured_at" >= "access_membership_snapshots"."sync_started_at")
);
--> statement-breakpoint
CREATE TABLE "activation_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"kind" "event_kind" NOT NULL,
	"template_mode" "template_mode" NOT NULL,
	"event_type_version_id" uuid NOT NULL,
	"roster_snapshot_id" uuid NOT NULL,
	"roster_population" "roster_population" NOT NULL,
	"audience_config_id" uuid NOT NULL,
	"audience_config_version" integer NOT NULL,
	"recipient_count" integer NOT NULL,
	"channels" jsonb NOT NULL,
	"send_readiness" varchar(16) NOT NULL,
	"blocking_reason_codes" jsonb NOT NULL,
	"active_event_ids" jsonb NOT NULL,
	"consequence_digest" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "activation_previews_preparation_anchor_uq" UNIQUE("id","facility_id","kind","template_mode","event_type_version_id","roster_snapshot_id","roster_population","audience_config_id","audience_config_version","consequence_digest"),
	CONSTRAINT "activation_previews_classification" CHECK ((
        "activation_previews"."kind" = 'incident' and "activation_previews"."template_mode" = 'real'
        and "activation_previews"."roster_population" = 'staff'
      ) or (
        "activation_previews"."kind" = 'drill' and "activation_previews"."template_mode" = 'drill'
      ) or (
        "activation_previews"."kind" = 'test' and "activation_previews"."template_mode" = 'drill'
        and "activation_previews"."roster_population" = 'synthetic'
      )),
	CONSTRAINT "activation_previews_count" CHECK ("activation_previews"."recipient_count" between 0 and 1200),
	CONSTRAINT "activation_previews_readiness" CHECK ("activation_previews"."send_readiness" in ('ready', 'blocked')),
	CONSTRAINT "activation_previews_expiry" CHECK ("activation_previews"."expires_at" >= "activation_previews"."created_at"
        and "activation_previews"."expires_at" <= "activation_previews"."created_at" + interval '15 minutes'),
	CONSTRAINT "activation_previews_digest_format" CHECK ("activation_previews"."consequence_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "agent_api_key_facilities" (
	"api_key_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	CONSTRAINT "agent_api_key_facilities_api_key_id_facility_id_pk" PRIMARY KEY("api_key_id","facility_id")
);
--> statement-breakpoint
CREATE TABLE "agent_api_key_grants" (
	"api_key_id" uuid NOT NULL,
	"capability_id" "agent_capability_grant" NOT NULL,
	CONSTRAINT "agent_api_key_grants_api_key_id_capability_id_pk" PRIMARY KEY("api_key_id","capability_id")
);
--> statement-breakpoint
CREATE TABLE "agent_api_key_revocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_key_id" uuid NOT NULL,
	"revoked_by_user_id" uuid NOT NULL,
	"reason_code" varchar(100) NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_api_key_revocations_key_uq" UNIQUE("api_key_id"),
	CONSTRAINT "agent_api_key_revocations_reason_format" CHECK ("agent_api_key_revocations"."reason_code" ~ '^[A-Z0-9_]+$')
);
--> statement-breakpoint
CREATE TABLE "agent_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"display_name" varchar(160) NOT NULL,
	"facility_scope_kind" "facility_scope_kind" NOT NULL,
	"key_prefix" varchar(24) NOT NULL,
	"credential_digest" varchar(64) NOT NULL,
	"issued_by_user_id" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agent_api_keys_lifecycle_times" CHECK (("agent_api_keys"."expires_at" is null or "agent_api_keys"."expires_at" >= "agent_api_keys"."issued_at")
        and ("agent_api_keys"."revoked_at" is null or "agent_api_keys"."revoked_at" >= "agent_api_keys"."issued_at")),
	CONSTRAINT "agent_api_keys_digest_format" CHECK ("agent_api_keys"."credential_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" varchar(160) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audience_configurations" (
	"id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audience_configurations_id_version_pk" PRIMARY KEY("id","version"),
	CONSTRAINT "audience_configurations_identity_facility_uq" UNIQUE("id","version","facility_id"),
	CONSTRAINT "audience_configurations_version_positive" CHECK ("audience_configurations"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "audience_targets" (
	"audience_config_id" uuid NOT NULL,
	"audience_config_version" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"target_kind" "audience_target_kind" NOT NULL,
	"target_facility_id" uuid,
	"neighborhood_id" uuid,
	"neighborhood_version" integer,
	"group_source_id" uuid,
	CONSTRAINT "audience_targets_audience_config_id_audience_config_version_ordinal_pk" PRIMARY KEY("audience_config_id","audience_config_version","ordinal"),
	CONSTRAINT "audience_targets_ordinal_positive" CHECK ("audience_targets"."ordinal" > 0),
	CONSTRAINT "audience_targets_valid_variant" CHECK ((
        "audience_targets"."target_kind" = 'building'
        and "audience_targets"."target_facility_id" is not null
        and "audience_targets"."neighborhood_id" is null
        and "audience_targets"."neighborhood_version" is null
        and "audience_targets"."group_source_id" is null
      ) or (
        "audience_targets"."target_kind" = 'neighborhood'
        and "audience_targets"."target_facility_id" is null
        and "audience_targets"."neighborhood_id" is not null
        and "audience_targets"."neighborhood_version" is not null
        and "audience_targets"."group_source_id" is null
      ) or (
        "audience_targets"."target_kind" = 'others'
        and "audience_targets"."target_facility_id" is null
        and "audience_targets"."neighborhood_id" is null
        and "audience_targets"."neighborhood_version" is null
        and "audience_targets"."group_source_id" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "channel_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_kind" "event_kind" NOT NULL,
	"template_mode" "template_mode" NOT NULL,
	"purpose" "notification_purpose" NOT NULL,
	"event_type_version_id" uuid NOT NULL,
	"roster_snapshot_id" uuid NOT NULL,
	"roster_population" "roster_population" NOT NULL,
	"recipient_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"attempt_number" integer NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_attempts_endpoint_attempt_uq" UNIQUE("batch_id","endpoint_id","attempt_number"),
	CONSTRAINT "channel_attempts_attempt_positive" CHECK ("channel_attempts"."attempt_number" > 0),
	CONSTRAINT "channel_attempts_classification" CHECK ((
        "channel_attempts"."event_kind" = 'incident' and "channel_attempts"."template_mode" = 'real'
        and "channel_attempts"."roster_population" = 'staff'
      ) or (
        "channel_attempts"."event_kind" = 'drill' and "channel_attempts"."template_mode" = 'drill'
      ) or (
        "channel_attempts"."event_kind" = 'test' and "channel_attempts"."template_mode" = 'drill'
        and "channel_attempts"."roster_population" = 'synthetic'
      ))
);
--> statement-breakpoint
CREATE TABLE "channel_configurations" (
	"integration_id" varchar(100) PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"status_id" uuid NOT NULL,
	"status_label" "integration_truth_label" NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_configurations_id_format" CHECK ("channel_configurations"."integration_id" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
	CONSTRAINT "channel_configurations_blocked_disabled" CHECK ("channel_configurations"."status_label" <> 'blocked' or "channel_configurations"."enabled" = false)
);
--> statement-breakpoint
CREATE TABLE "connectivity_epoch_invalidations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connectivity_epoch_id" uuid NOT NULL,
	"reason" varchar(32) NOT NULL,
	"invalidated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connectivity_epoch_invalidations_epoch_uq" UNIQUE("connectivity_epoch_id"),
	CONSTRAINT "connectivity_epoch_invalidations_reason" CHECK ("connectivity_epoch_invalidations"."reason" in ('disconnected', 'reconnected', 'session-revoked'))
);
--> statement-breakpoint
CREATE TABLE "connectivity_epochs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"established_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connectivity_epochs_identity_session_uq" UNIQUE("id","session_id")
);
--> statement-breakpoint
CREATE TABLE "delivery_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_kind" "delivery_evidence_subject_kind" NOT NULL,
	"subject_id" uuid NOT NULL,
	"intent_id" uuid,
	"attempt_id" uuid,
	"sequence" integer NOT NULL,
	"previous_evidence_id" uuid,
	"state" "delivery_truth_state" NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" varchar(100),
	"provider_reference" varchar(500),
	"proof" jsonb,
	"reason_code" varchar(100),
	"diagnostic_digest" varchar(64),
	CONSTRAINT "delivery_evidence_subject_sequence_uq" UNIQUE("subject_kind","subject_id","sequence"),
	CONSTRAINT "delivery_evidence_identity_subject_uq" UNIQUE("id","subject_kind","subject_id"),
	CONSTRAINT "delivery_evidence_sequence_positive" CHECK ("delivery_evidence"."sequence" > 0),
	CONSTRAINT "delivery_evidence_subject" CHECK ((
        "delivery_evidence"."subject_kind" = 'intent'
        and "delivery_evidence"."intent_id" is not null
        and "delivery_evidence"."subject_id" = "delivery_evidence"."intent_id"
        and "delivery_evidence"."attempt_id" is null
        and "delivery_evidence"."state" in ('accepted', 'recorded')
      ) or (
        "delivery_evidence"."subject_kind" = 'attempt'
        and "delivery_evidence"."intent_id" is null
        and "delivery_evidence"."attempt_id" is not null
        and "delivery_evidence"."subject_id" = "delivery_evidence"."attempt_id"
        and "delivery_evidence"."state" in (
          'attempted', 'provider-accepted', 'delivered', 'failed', 'expired', 'unknown'
        )
      )),
	CONSTRAINT "delivery_evidence_previous_sequence" CHECK (("delivery_evidence"."sequence" = 1) = ("delivery_evidence"."previous_evidence_id" is null)
        and ("delivery_evidence"."previous_evidence_id" is null or "delivery_evidence"."previous_evidence_id" <> "delivery_evidence"."id")),
	CONSTRAINT "delivery_evidence_provider_truth" CHECK ("delivery_evidence"."state" not in ('provider-accepted', 'delivered') or (
        "delivery_evidence"."provider" is not null and "delivery_evidence"."provider_reference" is not null
      )),
	CONSTRAINT "delivery_evidence_proof_truth" CHECK (("delivery_evidence"."state" = 'delivered') = ("delivery_evidence"."proof" is not null)),
	CONSTRAINT "delivery_evidence_reason_truth" CHECK (("delivery_evidence"."state" in ('failed', 'expired', 'unknown')) = ("delivery_evidence"."reason_code" is not null)
        and ("delivery_evidence"."diagnostic_digest" is null or "delivery_evidence"."reason_code" is not null))
);
--> statement-breakpoint
CREATE TABLE "device_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" "device_platform" NOT NULL,
	"unlock_method" "device_unlock_method" NOT NULL,
	"installation_id" varchar(255) NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "device_enrollments_identity_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "device_enrollments_identity_platform_uq" UNIQUE("id","platform"),
	CONSTRAINT "device_enrollments_unlock_platform" CHECK ((
        "device_enrollments"."platform" = 'web' and "device_enrollments"."unlock_method" = 'secure-session-cookie'
      ) or (
        "device_enrollments"."platform" in ('ios', 'android') and "device_enrollments"."unlock_method" = 'biometric'
      )),
	CONSTRAINT "device_enrollments_times" CHECK ("device_enrollments"."last_seen_at" >= "device_enrollments"."enrolled_at"
        and ("device_enrollments"."revoked_at" is null or "device_enrollments"."revoked_at" >= "device_enrollments"."enrolled_at"))
);
--> statement-breakpoint
CREATE TABLE "device_push_token_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_enrollment_id" uuid NOT NULL,
	"platform" "device_platform" NOT NULL,
	"token" text NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_push_token_registrations_identity_device_uq" UNIQUE("id","device_enrollment_id"),
	CONSTRAINT "device_push_token_registrations_native_only" CHECK ("device_push_token_registrations"."platform" in ('ios', 'android')),
	CONSTRAINT "device_push_token_registrations_token_length" CHECK (length(btrim("device_push_token_registrations"."token")) between 16 and 4096)
);
--> statement-breakpoint
CREATE TABLE "device_push_token_unregistrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registration_id" uuid NOT NULL,
	"device_enrollment_id" uuid NOT NULL,
	"unregistered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_push_token_unregistrations_registration_uq" UNIQUE("registration_id")
);
--> statement-breakpoint
CREATE TABLE "dispatch_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outbox_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_kind" "event_kind" NOT NULL,
	"template_mode" "template_mode" NOT NULL,
	"purpose" "notification_purpose" NOT NULL,
	"event_type_version_id" uuid NOT NULL,
	"roster_snapshot_id" uuid NOT NULL,
	"roster_population" "roster_population" NOT NULL,
	"audience_config_id" uuid NOT NULL,
	"audience_config_version" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"authorization" jsonb NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"rendered_message" jsonb NOT NULL,
	"integration_status_id" uuid NOT NULL,
	"integration_id" varchar(100) NOT NULL,
	"integration_label" "integration_truth_label" NOT NULL,
	"sequence" integer NOT NULL,
	"endpoint_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dispatch_batches_intent_channel_uq" UNIQUE("intent_id","channel"),
	CONSTRAINT "dispatch_batches_intent_sequence_uq" UNIQUE("intent_id","sequence"),
	CONSTRAINT "dispatch_batches_attempt_anchor_uq" UNIQUE("id","intent_id","event_id","event_kind","template_mode","purpose","event_type_version_id","roster_snapshot_id","roster_population","channel"),
	CONSTRAINT "dispatch_batches_sequence_positive" CHECK ("dispatch_batches"."sequence" > 0),
	CONSTRAINT "dispatch_batches_endpoint_count" CHECK ("dispatch_batches"."endpoint_count" between 0 and 12000),
	CONSTRAINT "dispatch_batches_classification" CHECK ((
        "dispatch_batches"."event_kind" = 'incident' and "dispatch_batches"."template_mode" = 'real'
        and "dispatch_batches"."roster_population" = 'staff'
      ) or (
        "dispatch_batches"."event_kind" = 'drill' and "dispatch_batches"."template_mode" = 'drill'
      ) or (
        "dispatch_batches"."event_kind" = 'test' and "dispatch_batches"."template_mode" = 'drill'
        and "dispatch_batches"."roster_population" = 'synthetic'
      )),
	CONSTRAINT "dispatch_batches_rendered_truth" CHECK (jsonb_typeof("dispatch_batches"."rendered_message") is not distinct from 'object'
        and "dispatch_batches"."rendered_message" ->> 'channel' is not distinct from "dispatch_batches"."channel"::text
        and "dispatch_batches"."rendered_message" ->> 'eventKind' is not distinct from "dispatch_batches"."event_kind"::text
        and "dispatch_batches"."rendered_message" ->> 'templateMode' is not distinct from "dispatch_batches"."template_mode"::text
        and "dispatch_batches"."rendered_message" ->> 'purpose' is not distinct from "dispatch_batches"."purpose"::text
        and "dispatch_batches"."rendered_message" ->> 'classificationMarker' is not distinct from case
          when "dispatch_batches"."template_mode" = 'real' then 'INCIDENT'
          else 'DRILL'
        end),
	CONSTRAINT "dispatch_batches_integration_channel" CHECK ((
        "dispatch_batches"."channel" = 'push' and "dispatch_batches"."integration_id" = 'expo-push'
      ) or (
        "dispatch_batches"."channel" = 'email' and "dispatch_batches"."integration_id" = 'ses-email'
      ) or (
        "dispatch_batches"."channel" = 'sms' and "dispatch_batches"."integration_id" = 'aws-eum-sms'
      )),
	CONSTRAINT "dispatch_batches_integration_population" CHECK ((
        "dispatch_batches"."roster_population" = 'staff'
        and "dispatch_batches"."integration_label" = 'live-verified'
      ) or (
        "dispatch_batches"."roster_population" = 'synthetic'
        and "dispatch_batches"."integration_label" = 'mocked'
      ))
);
--> statement-breakpoint
CREATE TABLE "endpoint_status_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"roster_snapshot_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"population" "roster_population" NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"status" "endpoint_status" NOT NULL,
	"reason_code" varchar(100) NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "endpoint_status_records_terminal_status" CHECK ("endpoint_status_records"."status" in ('invalid', 'disabled')),
	CONSTRAINT "endpoint_status_records_reason_format" CHECK ("endpoint_status_records"."reason_code" ~ '^[A-Z0-9_]+$')
);
--> statement-breakpoint
CREATE TABLE "event_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" integer NOT NULL,
	"transition" "event_transition_kind" NOT NULL,
	"event_id" uuid,
	"source_event_id" uuid,
	"correction_event_id" uuid,
	"journal_event_id" uuid NOT NULL,
	"from_status" "event_status" NOT NULL,
	"to_status" "event_status" NOT NULL,
	"kind" "event_kind" NOT NULL,
	"template_mode" "template_mode" NOT NULL,
	"roster_population" "roster_population" NOT NULL,
	"actor" jsonb NOT NULL,
	"source" "invocation_source" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"request_id" uuid NOT NULL,
	"confirmation_id" uuid,
	"confirmation_status" "human_confirmation_status",
	"consequence_digest" varchar(64),
	"idempotency_key" varchar(255) NOT NULL,
	"activation_authorization" jsonb,
	"notification_authorization" jsonb,
	"correction_reason" varchar(1000),
	CONSTRAINT "event_transitions_journal_event_uq" UNIQUE("id","journal_event_id"),
	CONSTRAINT "event_transitions_sequence_positive" CHECK ("event_transitions"."sequence" > 0),
	CONSTRAINT "event_transitions_confirmation_status" CHECK ((
        "event_transitions"."confirmation_id" is null
        and "event_transitions"."confirmation_status" is null
        and "event_transitions"."consequence_digest" is null
      ) or (
        "event_transitions"."confirmation_id" is not null
        and "event_transitions"."confirmation_status" = 'consumed'
        and "event_transitions"."consequence_digest" is not null
      )),
	CONSTRAINT "event_transitions_protected_human_boundary" CHECK (case
        when "event_transitions"."transition" in ('activate', 'all-clear', 'reactivate')
          and "event_transitions"."roster_population" = 'staff' then
          "event_transitions"."confirmation_id" is not null
          and ("event_transitions"."actor" ->> 'kind' is not distinct from 'human')
        when "event_transitions"."transition" = 'close' and "event_transitions"."kind" = 'incident' then
          "event_transitions"."confirmation_id" is not null
          and ("event_transitions"."actor" ->> 'kind' is not distinct from 'human')
        when "event_transitions"."transition" = 'close'
          and "event_transitions"."roster_population" = 'staff' then
          "event_transitions"."confirmation_id" is null
          and ("event_transitions"."actor" ->> 'kind' is not distinct from 'human')
        else "event_transitions"."confirmation_id" is null
      end),
	CONSTRAINT "event_transitions_actor_source" CHECK (case "event_transitions"."actor" ->> 'kind'
        when 'human' then "event_transitions"."source" in ('web', 'mobile')
        when 'agent' then "event_transitions"."source" in ('agent-rest', 'mcp')
        when 'system' then "event_transitions"."source" in ('worker', 'scheduled-job', 'webhook')
        else false
      end),
	CONSTRAINT "event_transitions_classification" CHECK ((
        "event_transitions"."kind" = 'incident' and "event_transitions"."template_mode" = 'real'
        and "event_transitions"."roster_population" = 'staff'
      ) or (
        "event_transitions"."kind" = 'drill' and "event_transitions"."template_mode" = 'drill'
      ) or (
        "event_transitions"."kind" = 'test' and "event_transitions"."template_mode" = 'drill'
        and "event_transitions"."roster_population" = 'synthetic'
      )),
	CONSTRAINT "event_transitions_variant" CHECK ((
        "event_transitions"."transition" = 'activate'
        and "event_transitions"."event_id" is not null
        and "event_transitions"."journal_event_id" = "event_transitions"."event_id"
        and "event_transitions"."source_event_id" is null
        and "event_transitions"."correction_event_id" is null
        and "event_transitions"."from_status" = 'draft'
        and "event_transitions"."to_status" = 'active'
        and "event_transitions"."activation_authorization" is not null
        and "event_transitions"."notification_authorization" is null
        and "event_transitions"."correction_reason" is null
      ) or (
        "event_transitions"."transition" = 'all-clear'
        and "event_transitions"."event_id" is not null
        and "event_transitions"."journal_event_id" = "event_transitions"."event_id"
        and "event_transitions"."source_event_id" is null
        and "event_transitions"."correction_event_id" is null
        and "event_transitions"."from_status" = 'active'
        and "event_transitions"."to_status" = 'all-clear'
        and "event_transitions"."activation_authorization" is null
        and "event_transitions"."notification_authorization" is not null
        and "event_transitions"."correction_reason" is null
      ) or (
        "event_transitions"."transition" = 'reactivate'
        and "event_transitions"."event_id" is not null
        and "event_transitions"."journal_event_id" = "event_transitions"."event_id"
        and "event_transitions"."source_event_id" is null
        and "event_transitions"."correction_event_id" is null
        and "event_transitions"."from_status" = 'all-clear'
        and "event_transitions"."to_status" = 'active'
        and "event_transitions"."activation_authorization" is null
        and "event_transitions"."notification_authorization" is not null
        and "event_transitions"."correction_reason" is null
      ) or (
        "event_transitions"."transition" = 'close'
        and "event_transitions"."event_id" is not null
        and "event_transitions"."journal_event_id" = "event_transitions"."event_id"
        and "event_transitions"."source_event_id" is null
        and "event_transitions"."correction_event_id" is null
        and "event_transitions"."from_status" = 'all-clear'
        and "event_transitions"."to_status" = 'closed'
        and "event_transitions"."activation_authorization" is null
        and "event_transitions"."notification_authorization" is null
        and "event_transitions"."correction_reason" is null
      ) or (
        "event_transitions"."transition" = 'reopen-as-correction'
        and "event_transitions"."event_id" is null
        and "event_transitions"."source_event_id" is not null
        and "event_transitions"."correction_event_id" is not null
        and "event_transitions"."journal_event_id" = "event_transitions"."correction_event_id"
        and "event_transitions"."source_event_id" <> "event_transitions"."correction_event_id"
        and "event_transitions"."from_status" = 'closed'
        and "event_transitions"."to_status" = 'draft'
        and "event_transitions"."activation_authorization" is null
        and "event_transitions"."notification_authorization" is null
        and "event_transitions"."correction_reason" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "event_type_draft_templates" (
	"event_type_version_draft_id" uuid NOT NULL,
	"template_mode" "template_mode" NOT NULL,
	"purpose" "notification_purpose" NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"classification_marker" "classification_marker" NOT NULL,
	"title" varchar(120),
	"subject" varchar(200),
	"body" varchar(1000),
	"text_body" text,
	CONSTRAINT "event_type_draft_templates_event_type_version_draft_id_purpose_channel_pk" PRIMARY KEY("event_type_version_draft_id","purpose","channel"),
	CONSTRAINT "event_type_draft_templates_marker_matches_mode" CHECK ((
        "event_type_draft_templates"."template_mode" = 'real' and "event_type_draft_templates"."classification_marker" = 'INCIDENT'
      ) or (
        "event_type_draft_templates"."template_mode" = 'drill' and "event_type_draft_templates"."classification_marker" = 'DRILL'
      )),
	CONSTRAINT "event_type_draft_templates_channel_fields" CHECK ((
        "event_type_draft_templates"."channel" = 'push'
        and "event_type_draft_templates"."title" is not null
        and "event_type_draft_templates"."body" is not null
        and length("event_type_draft_templates"."body") <= 500
        and "event_type_draft_templates"."subject" is null
        and "event_type_draft_templates"."text_body" is null
      ) or (
        "event_type_draft_templates"."channel" = 'email'
        and "event_type_draft_templates"."title" is null
        and "event_type_draft_templates"."body" is null
        and "event_type_draft_templates"."subject" is not null
        and "event_type_draft_templates"."text_body" is not null
        and length("event_type_draft_templates"."text_body") <= 10000
      ) or (
        "event_type_draft_templates"."channel" = 'sms'
        and "event_type_draft_templates"."title" is null
        and "event_type_draft_templates"."body" is not null
        and "event_type_draft_templates"."subject" is null
        and "event_type_draft_templates"."text_body" is null
      ))
);
--> statement-breakpoint
CREATE TABLE "event_type_templates" (
	"event_type_version_id" uuid NOT NULL,
	"template_mode" "template_mode" NOT NULL,
	"purpose" "notification_purpose" NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"classification_marker" "classification_marker" NOT NULL,
	"title" varchar(120),
	"subject" varchar(200),
	"body" varchar(1000),
	"text_body" text,
	CONSTRAINT "event_type_templates_event_type_version_id_purpose_channel_pk" PRIMARY KEY("event_type_version_id","purpose","channel"),
	CONSTRAINT "event_type_templates_marker_matches_mode" CHECK ((
        "event_type_templates"."template_mode" = 'real' and "event_type_templates"."classification_marker" = 'INCIDENT'
      ) or (
        "event_type_templates"."template_mode" = 'drill' and "event_type_templates"."classification_marker" = 'DRILL'
      )),
	CONSTRAINT "event_type_templates_channel_fields" CHECK ((
        "event_type_templates"."channel" = 'push'
        and "event_type_templates"."title" is not null
        and "event_type_templates"."body" is not null
        and length("event_type_templates"."body") <= 500
        and "event_type_templates"."subject" is null
        and "event_type_templates"."text_body" is null
      ) or (
        "event_type_templates"."channel" = 'email'
        and "event_type_templates"."title" is null
        and "event_type_templates"."body" is null
        and "event_type_templates"."subject" is not null
        and "event_type_templates"."text_body" is not null
        and length("event_type_templates"."text_body") <= 10000
      ) or (
        "event_type_templates"."channel" = 'sms'
        and "event_type_templates"."title" is null
        and "event_type_templates"."body" is not null
        and "event_type_templates"."subject" is null
        and "event_type_templates"."text_body" is null
      ))
);
--> statement-breakpoint
CREATE TABLE "event_type_version_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type_id" uuid NOT NULL,
	"template_mode" "template_mode" NOT NULL,
	"name" varchar(160) NOT NULL,
	"description" varchar(1000),
	"drafted_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_type_version_drafts_identity_mode_uq" UNIQUE("id","template_mode")
);
--> statement-breakpoint
CREATE TABLE "event_type_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"template_mode" "template_mode" NOT NULL,
	"name" varchar(160) NOT NULL,
	"description" varchar(1000),
	"enabled" boolean NOT NULL,
	"supersedes_version_id" uuid,
	"created_by" jsonb NOT NULL,
	"publication_authorization" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_type_versions_type_version_uq" UNIQUE("event_type_id","version"),
	CONSTRAINT "event_type_versions_identity_mode_uq" UNIQUE("id","template_mode"),
	CONSTRAINT "event_type_versions_version_positive" CHECK ("event_type_versions"."version" > 0),
	CONSTRAINT "event_type_versions_not_self_superseding" CHECK ("event_type_versions"."supersedes_version_id" is null or "event_type_versions"."supersedes_version_id" <> "event_type_versions"."id")
);
--> statement-breakpoint
CREATE TABLE "event_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(100) NOT NULL,
	"family_key" varchar(100) NOT NULL,
	"template_mode" "template_mode" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_types_identity_mode_uq" UNIQUE("id","template_mode"),
	CONSTRAINT "event_types_key_format" CHECK ("event_types"."key" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
	CONSTRAINT "event_types_family_key_format" CHECK ("event_types"."family_key" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"kind" "event_kind" NOT NULL,
	"template_mode" "template_mode" NOT NULL,
	"event_type_version_id" uuid NOT NULL,
	"status" "event_status" NOT NULL,
	"roster_snapshot_id" uuid,
	"roster_population" "roster_population",
	"created_by" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"all_clear_at" timestamp with time zone,
	"reactivated_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"correction_of_event_id" uuid,
	"correction_reason" varchar(1000),
	"activation_authorization" jsonb,
	CONSTRAINT "events_identity_classification_uq" UNIQUE("id","kind","template_mode"),
	CONSTRAINT "events_identity_targeting_uq" UNIQUE("id","kind","template_mode","roster_population"),
	CONSTRAINT "events_prepared_activation_anchor_uq" UNIQUE("id","facility_id","kind","template_mode","event_type_version_id","roster_snapshot_id","roster_population"),
	CONSTRAINT "events_classification" CHECK ((
        "events"."kind" = 'incident' and "events"."template_mode" = 'real'
      ) or (
        "events"."kind" in ('drill', 'test') and "events"."template_mode" = 'drill'
      )),
	CONSTRAINT "events_targeting" CHECK ("events"."roster_population" is null or (
        "events"."kind" = 'incident' and "events"."roster_population" = 'staff'
      ) or (
        "events"."kind" = 'drill'
      ) or (
        "events"."kind" = 'test' and "events"."roster_population" = 'synthetic'
      )),
	CONSTRAINT "events_draft_or_activated" CHECK ((
        "events"."status" = 'draft'
        and "events"."roster_snapshot_id" is null
        and "events"."roster_population" is null
        and "events"."activated_at" is null
        and "events"."all_clear_at" is null
        and "events"."reactivated_at" is null
        and "events"."closed_at" is null
        and "events"."activation_authorization" is null
      ) or (
        "events"."status" <> 'draft'
        and "events"."roster_snapshot_id" is not null
        and "events"."roster_population" is not null
        and "events"."activated_at" is not null
        and "events"."activation_authorization" is not null
      )),
	CONSTRAINT "events_activation_authorization_truth" CHECK ("events"."status" = 'draft' or case
        when "events"."roster_population" = 'staff' then
          "events"."created_by" ->> 'kind' is not distinct from 'human'
          and "events"."activation_authorization" ->> 'kind' is not distinct from 'human-confirmed'
        when "events"."roster_population" = 'synthetic' then
          "events"."activation_authorization" ->> 'kind' is not distinct from 'synthetic-training'
        else false
      end),
	CONSTRAINT "events_lifecycle_state" CHECK ((
        "events"."status" = 'draft'
      ) or (
        "events"."status" = 'active'
        and "events"."closed_at" is null
        and (
          ("events"."all_clear_at" is null and "events"."reactivated_at" is null)
          or ("events"."all_clear_at" is not null and "events"."reactivated_at" is not null)
        )
      ) or (
        "events"."status" = 'all-clear'
        and "events"."all_clear_at" is not null
        and "events"."closed_at" is null
      ) or (
        "events"."status" = 'closed'
        and "events"."all_clear_at" is not null
        and "events"."closed_at" is not null
      )),
	CONSTRAINT "events_correction_pair" CHECK (("events"."correction_of_event_id" is null) = ("events"."correction_reason" is null)
        and ("events"."correction_of_event_id" is null or "events"."correction_of_event_id" <> "events"."id"))
);
--> statement-breakpoint
CREATE TABLE "facilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(160) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facilities_code_format" CHECK ("facilities"."code" ~ '^[A-Z0-9-]+$'),
	CONSTRAINT "facilities_name_nonempty" CHECK (length(btrim("facilities"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "group_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "group_source_kind" NOT NULL,
	"purpose" "group_purpose" NOT NULL,
	"facility_id" uuid,
	"display_name" varchar(160) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"google_group_id" varchar(255),
	"email" varchar(320),
	"fixture_key" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_sources_identity_kind_purpose_uq" UNIQUE("id","kind","purpose"),
	CONSTRAINT "group_sources_google_group_id_uq" UNIQUE("google_group_id"),
	CONSTRAINT "group_sources_fixture_key_uq" UNIQUE("fixture_key"),
	CONSTRAINT "group_sources_valid_variant" CHECK ((
        "group_sources"."kind" = 'google-group'
        and "group_sources"."google_group_id" is not null
        and "group_sources"."email" is not null
        and "group_sources"."fixture_key" is null
        and (
          ("group_sources"."purpose" = 'building' and "group_sources"."facility_id" is not null)
          or ("group_sources"."purpose" in ('access', 'others') and "group_sources"."facility_id" is null)
        )
      ) or (
        "group_sources"."kind" = 'synthetic'
        and "group_sources"."google_group_id" is null
        and "group_sources"."email" is null
        and "group_sources"."fixture_key" is not null
        and "group_sources"."purpose" in ('building', 'others')
        and (
          ("group_sources"."purpose" = 'building' and "group_sources"."facility_id" is not null)
          or ("group_sources"."purpose" = 'others' and "group_sources"."facility_id" is null)
        )
      )),
	CONSTRAINT "group_sources_fixture_key_format" CHECK ("group_sources"."fixture_key" is null or "group_sources"."fixture_key" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "human_confirmation_actions" (
	"confirmation_id" uuid NOT NULL,
	"action_id" "human_only_action" NOT NULL,
	CONSTRAINT "human_confirmation_actions_confirmation_id_action_id_pk" PRIMARY KEY("confirmation_id","action_id")
);
--> statement-breakpoint
CREATE TABLE "human_confirmation_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"capability_id" "mutation_capability" NOT NULL,
	"connectivity_epoch_id" uuid NOT NULL,
	"confirmed_by_user_id" uuid NOT NULL,
	"confirmed_with_session_id" uuid NOT NULL,
	"consequence_digest" varchar(64) NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "human_confirmation_status" NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_for_request_id" uuid,
	"expired_at" timestamp with time zone,
	CONSTRAINT "human_confirmation_records_consumption_anchor_uq" UNIQUE("id","status","consumed_for_request_id","consequence_digest"),
	CONSTRAINT "human_confirmation_records_consumed_request_uq" UNIQUE("consumed_for_request_id"),
	CONSTRAINT "human_confirmation_records_digest_format" CHECK ("human_confirmation_records"."consequence_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "human_confirmation_records_expiry_bound" CHECK ("human_confirmation_records"."expires_at" >= "human_confirmation_records"."issued_at"
        and "human_confirmation_records"."expires_at" <= "human_confirmation_records"."issued_at" + interval '5 minutes'),
	CONSTRAINT "human_confirmation_records_status" CHECK ((
        "human_confirmation_records"."status" = 'issued'
        and "human_confirmation_records"."consumed_at" is null
        and "human_confirmation_records"."consumed_for_request_id" is null
        and "human_confirmation_records"."expired_at" is null
      ) or (
        "human_confirmation_records"."status" = 'consumed'
        and "human_confirmation_records"."consumed_at" is not null
        and "human_confirmation_records"."consumed_at" between "human_confirmation_records"."issued_at" and "human_confirmation_records"."expires_at"
        and "human_confirmation_records"."consumed_for_request_id" is not null
        and "human_confirmation_records"."expired_at" is null
      ) or (
        "human_confirmation_records"."status" = 'expired'
        and "human_confirmation_records"."consumed_at" is null
        and "human_confirmation_records"."consumed_for_request_id" is null
        and "human_confirmation_records"."expired_at" is not null
        and "human_confirmation_records"."expired_at" >= "human_confirmation_records"."expires_at"
      ))
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(200) NOT NULL,
	"capability_id" "mutation_capability" NOT NULL,
	"principal" jsonb NOT NULL,
	"principal_digest" varchar(64) NOT NULL,
	"request_digest" varchar(64) NOT NULL,
	"status" "idempotency_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"result_reference" varchar(500),
	CONSTRAINT "idempotency_records_scope_key_uq" UNIQUE("capability_id","principal_digest","key"),
	CONSTRAINT "idempotency_records_key_format" CHECK (length("idempotency_records"."key") between 16 and 200
        and "idempotency_records"."key" ~ '^[A-Za-z0-9._:-]+$'),
	CONSTRAINT "idempotency_records_digest_format" CHECK ("idempotency_records"."principal_digest" ~ '^[a-f0-9]{64}$'
        and "idempotency_records"."request_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "idempotency_records_terminal_state" CHECK ((
        "idempotency_records"."status" = 'in-progress'
        and "idempotency_records"."completed_at" is null
        and "idempotency_records"."result_reference" is null
      ) or (
        "idempotency_records"."status" in ('completed', 'failed')
        and "idempotency_records"."completed_at" is not null
        and "idempotency_records"."completed_at" >= "idempotency_records"."created_at"
        and "idempotency_records"."result_reference" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "integration_statuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" varchar(100) NOT NULL,
	"label" "integration_truth_label" NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by_user_id" uuid,
	"authorization_reference" varchar(255),
	"reason_code" varchar(100),
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_statuses_identity_integration_label_uq" UNIQUE("id","integration_id","label"),
	CONSTRAINT "integration_statuses_id_format" CHECK ("integration_statuses"."integration_id" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
	CONSTRAINT "integration_statuses_verification_truth" CHECK ((
        "integration_statuses"."label" = 'live-verified'
        and "integration_statuses"."verified_at" is not null
        and "integration_statuses"."verified_by_user_id" is not null
        and "integration_statuses"."authorization_reference" is not null
        and "integration_statuses"."reason_code" is null
      ) or (
        "integration_statuses"."label" <> 'live-verified'
        and "integration_statuses"."verified_at" is null
        and "integration_statuses"."verified_by_user_id" is null
        and "integration_statuses"."authorization_reference" is null
        and (
          ("integration_statuses"."label" = 'blocked' and "integration_statuses"."reason_code" is not null)
          or ("integration_statuses"."label" <> 'blocked' and "integration_statuses"."reason_code" is null)
        )
      )),
	CONSTRAINT "integration_statuses_verified_before_observed" CHECK ("integration_statuses"."verified_at" is null or "integration_statuses"."verified_at" <= "integration_statuses"."observed_at")
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" "journal_entry_kind" NOT NULL,
	"author" jsonb NOT NULL,
	"source" "invocation_source" NOT NULL,
	"server_time" timestamp with time zone DEFAULT now() NOT NULL,
	"client_time" timestamp with time zone,
	"payload" jsonb NOT NULL,
	"media_id" uuid,
	"transition_id" uuid,
	"supersedes_entry_id" uuid,
	"supersedes_entry_sequence" integer,
	"supersession_kind" "journal_supersession_kind",
	"supersession_reason" varchar(1000),
	CONSTRAINT "journal_entries_event_sequence_uq" UNIQUE("event_id","sequence"),
	CONSTRAINT "journal_entries_event_identity_sequence_uq" UNIQUE("event_id","id","sequence"),
	CONSTRAINT "journal_entries_sequence_positive" CHECK ("journal_entries"."sequence" > 0),
	CONSTRAINT "journal_entries_payload_reference" CHECK ((
        "journal_entries"."kind" = 'photo' and "journal_entries"."media_id" is not null
        and "journal_entries"."transition_id" is null
      ) or (
        "journal_entries"."kind" = 'system' and "journal_entries"."media_id" is null
      ) or (
        "journal_entries"."kind" in ('text', 'location')
        and "journal_entries"."media_id" is null and "journal_entries"."transition_id" is null
      )),
	CONSTRAINT "journal_entries_supersession_complete" CHECK ((
        "journal_entries"."supersedes_entry_id" is null
        and "journal_entries"."supersedes_entry_sequence" is null
        and "journal_entries"."supersession_kind" is null
        and "journal_entries"."supersession_reason" is null
      ) or (
        "journal_entries"."kind" <> 'system'
        and "journal_entries"."supersedes_entry_id" is not null
        and "journal_entries"."supersedes_entry_sequence" is not null
        and "journal_entries"."supersedes_entry_sequence" < "journal_entries"."sequence"
        and "journal_entries"."supersession_kind" is not null
        and "journal_entries"."supersession_reason" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "lifecycle_consequence_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"purpose" "notification_purpose" NOT NULL,
	"kind" "event_kind" NOT NULL,
	"template_mode" "template_mode" NOT NULL,
	"event_type_version_id" uuid NOT NULL,
	"roster_snapshot_id" uuid NOT NULL,
	"roster_population" "roster_population" NOT NULL,
	"audience_config_id" uuid NOT NULL,
	"audience_config_version" integer NOT NULL,
	"recipient_count" integer NOT NULL,
	"channels" jsonb NOT NULL,
	"send_readiness" varchar(16) NOT NULL,
	"blocking_reason_codes" jsonb NOT NULL,
	"consequence_digest" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lifecycle_consequence_previews_purpose" CHECK ("lifecycle_consequence_previews"."purpose" in ('all-clear', 'reactivation')),
	CONSTRAINT "lifecycle_consequence_previews_classification" CHECK ((
        "lifecycle_consequence_previews"."kind" = 'incident' and "lifecycle_consequence_previews"."template_mode" = 'real'
        and "lifecycle_consequence_previews"."roster_population" = 'staff'
      ) or (
        "lifecycle_consequence_previews"."kind" = 'drill' and "lifecycle_consequence_previews"."template_mode" = 'drill'
      ) or (
        "lifecycle_consequence_previews"."kind" = 'test' and "lifecycle_consequence_previews"."template_mode" = 'drill'
        and "lifecycle_consequence_previews"."roster_population" = 'synthetic'
      )),
	CONSTRAINT "lifecycle_consequence_previews_count" CHECK ("lifecycle_consequence_previews"."recipient_count" between 0 and 1200),
	CONSTRAINT "lifecycle_consequence_previews_expiry" CHECK ("lifecycle_consequence_previews"."expires_at" >= "lifecycle_consequence_previews"."created_at"
        and "lifecycle_consequence_previews"."expires_at" <= "lifecycle_consequence_previews"."created_at" + interval '15 minutes')
);
--> statement-breakpoint
CREATE TABLE "media_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upload_intent_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"status" varchar(16) NOT NULL,
	"detected_content_type" "media_content_type" NOT NULL,
	"sanitized_byte_length" integer NOT NULL,
	"sanitized_content_sha256" varchar(64) NOT NULL,
	"storage_key" text NOT NULL,
	"malware_scan" varchar(16) NOT NULL,
	"exif_stripped" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_records_identity_event_uq" UNIQUE("id","event_id"),
	CONSTRAINT "media_records_upload_intent_uq" UNIQUE("upload_intent_id"),
	CONSTRAINT "media_records_ready" CHECK ("media_records"."status" = 'ready'),
	CONSTRAINT "media_records_scan_clean" CHECK ("media_records"."malware_scan" = 'clean'),
	CONSTRAINT "media_records_exif_stripped" CHECK ("media_records"."exif_stripped" = true),
	CONSTRAINT "media_records_size" CHECK ("media_records"."sanitized_byte_length" between 1 and 26214400)
);
--> statement-breakpoint
CREATE TABLE "media_upload_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"byte_length" integer NOT NULL,
	"content_sha256" varchar(64) NOT NULL,
	"declared_content_type" "media_content_type" NOT NULL,
	"storage_key" text NOT NULL,
	"status" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "media_upload_intents_identity_event_uq" UNIQUE("id","event_id"),
	CONSTRAINT "media_upload_intents_size" CHECK ("media_upload_intents"."byte_length" between 1 and 26214400),
	CONSTRAINT "media_upload_intents_status" CHECK ("media_upload_intents"."status" in ('pending-upload', 'completed', 'rejected', 'expired')),
	CONSTRAINT "media_upload_intents_expiry" CHECK ("media_upload_intents"."expires_at" >= "media_upload_intents"."created_at"
        and "media_upload_intents"."expires_at" <= "media_upload_intents"."created_at" + interval '15 minutes')
);
--> statement-breakpoint
CREATE TABLE "neighborhood_facilities" (
	"neighborhood_id" uuid NOT NULL,
	"neighborhood_version" integer NOT NULL,
	"facility_id" uuid NOT NULL,
	CONSTRAINT "neighborhood_facilities_neighborhood_id_neighborhood_version_facility_id_pk" PRIMARY KEY("neighborhood_id","neighborhood_version","facility_id")
);
--> statement-breakpoint
CREATE TABLE "neighborhood_versions" (
	"id" uuid NOT NULL,
	"version" integer NOT NULL,
	"name" varchar(160) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "neighborhood_versions_id_version_pk" PRIMARY KEY("id","version"),
	CONSTRAINT "neighborhood_versions_version_positive" CHECK ("neighborhood_versions"."version" > 0),
	CONSTRAINT "neighborhood_versions_name_nonempty" CHECK (length(btrim("neighborhood_versions"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "notification_intent_channels" (
	"intent_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"event_kind" "event_kind" NOT NULL,
	"template_mode" "template_mode" NOT NULL,
	"purpose" "notification_purpose" NOT NULL,
	"roster_population" "roster_population" NOT NULL,
	"classification_marker" "classification_marker" NOT NULL,
	"endpoint_count" integer NOT NULL,
	"rendered_message" jsonb NOT NULL,
	"integration_status_id" uuid NOT NULL,
	"integration_id" varchar(100) NOT NULL,
	"integration_label" "integration_truth_label" NOT NULL,
	CONSTRAINT "notification_intent_channels_intent_id_channel_pk" PRIMARY KEY("intent_id","channel"),
	CONSTRAINT "notification_intent_channels_sequence_uq" UNIQUE("intent_id","sequence"),
	CONSTRAINT "notification_intent_channels_sequence_positive" CHECK ("notification_intent_channels"."sequence" > 0),
	CONSTRAINT "notification_intent_channels_endpoint_count" CHECK ("notification_intent_channels"."endpoint_count" between 0 and 12000),
	CONSTRAINT "notification_intent_channels_classification" CHECK ((
        "notification_intent_channels"."event_kind" = 'incident'
        and "notification_intent_channels"."template_mode" = 'real'
        and "notification_intent_channels"."classification_marker" = 'INCIDENT'
      ) or (
        "notification_intent_channels"."event_kind" in ('drill', 'test')
        and "notification_intent_channels"."template_mode" = 'drill'
        and "notification_intent_channels"."classification_marker" = 'DRILL'
      )),
	CONSTRAINT "notification_intent_channels_rendered_truth" CHECK (jsonb_typeof("notification_intent_channels"."rendered_message") is not distinct from 'object'
        and "notification_intent_channels"."rendered_message" ->> 'channel' is not distinct from "notification_intent_channels"."channel"::text
        and "notification_intent_channels"."rendered_message" ->> 'eventKind' is not distinct from "notification_intent_channels"."event_kind"::text
        and "notification_intent_channels"."rendered_message" ->> 'templateMode' is not distinct from "notification_intent_channels"."template_mode"::text
        and "notification_intent_channels"."rendered_message" ->> 'purpose' is not distinct from "notification_intent_channels"."purpose"::text
        and "notification_intent_channels"."rendered_message" ->> 'classificationMarker' is not distinct from "notification_intent_channels"."classification_marker"::text),
	CONSTRAINT "notification_intent_channels_integration_channel" CHECK ((
        "notification_intent_channels"."channel" = 'push' and "notification_intent_channels"."integration_id" = 'expo-push'
      ) or (
        "notification_intent_channels"."channel" = 'email' and "notification_intent_channels"."integration_id" = 'ses-email'
      ) or (
        "notification_intent_channels"."channel" = 'sms' and "notification_intent_channels"."integration_id" = 'aws-eum-sms'
      )),
	CONSTRAINT "notification_intent_channels_integration_population" CHECK ((
        "notification_intent_channels"."roster_population" = 'staff'
        and "notification_intent_channels"."integration_label" = 'live-verified'
      ) or (
        "notification_intent_channels"."roster_population" = 'synthetic'
        and "notification_intent_channels"."integration_label" = 'mocked'
      ))
);
--> statement-breakpoint
CREATE TABLE "notification_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"event_kind" "event_kind" NOT NULL,
	"template_mode" "template_mode" NOT NULL,
	"purpose" "notification_purpose" NOT NULL,
	"event_type_version_id" uuid NOT NULL,
	"roster_snapshot_id" uuid NOT NULL,
	"roster_population" "roster_population" NOT NULL,
	"audience_config_id" uuid NOT NULL,
	"audience_config_version" integer NOT NULL,
	"created_by" jsonb NOT NULL,
	"source" "invocation_source" NOT NULL,
	"request_id" uuid NOT NULL,
	"authorization" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_intents_identity_classification_uq" UNIQUE("id","event_kind","template_mode","purpose"),
	CONSTRAINT "notification_intents_channel_anchor_uq" UNIQUE("id","event_kind","template_mode","purpose","roster_population"),
	CONSTRAINT "notification_intents_attempt_anchor_uq" UNIQUE("id","event_id","event_kind","template_mode","purpose","event_type_version_id","roster_snapshot_id","roster_population"),
	CONSTRAINT "notification_intents_worker_anchor_uq" UNIQUE("id","event_id","event_kind","template_mode","purpose","event_type_version_id","roster_snapshot_id","roster_population","audience_config_id","audience_config_version","request_id","authorization"),
	CONSTRAINT "notification_intents_classification" CHECK ((
        "notification_intents"."event_kind" = 'incident' and "notification_intents"."template_mode" = 'real'
        and "notification_intents"."roster_population" = 'staff'
      ) or (
        "notification_intents"."event_kind" = 'drill' and "notification_intents"."template_mode" = 'drill'
      ) or (
        "notification_intents"."event_kind" = 'test' and "notification_intents"."template_mode" = 'drill'
        and "notification_intents"."roster_population" = 'synthetic'
      )),
	CONSTRAINT "notification_intents_authorization_truth" CHECK ((
        "notification_intents"."authorization" ->> 'requestId' is not distinct from "notification_intents"."request_id"::text
      ) and case
        when "notification_intents"."purpose" = 'activation' and "notification_intents"."roster_population" = 'staff' then
          "notification_intents"."authorization" ->> 'kind' is not distinct from 'human-confirmed'
          and "notification_intents"."created_by" ->> 'kind' is not distinct from 'human'
        when "notification_intents"."purpose" = 'activation' and "notification_intents"."roster_population" = 'synthetic' then
          "notification_intents"."authorization" ->> 'kind' is not distinct from 'synthetic-training'
        when "notification_intents"."purpose" <> 'activation' and "notification_intents"."roster_population" = 'staff' then
          "notification_intents"."authorization" ->> 'kind' is not distinct from 'human-confirmed-lifecycle'
          and "notification_intents"."authorization" ->> 'purpose' is not distinct from "notification_intents"."purpose"::text
          and "notification_intents"."created_by" ->> 'kind' is not distinct from 'human'
        when "notification_intents"."purpose" <> 'activation' and "notification_intents"."roster_population" = 'synthetic' then
          "notification_intents"."authorization" ->> 'kind' is not distinct from 'synthetic-lifecycle'
          and "notification_intents"."authorization" ->> 'purpose' is not distinct from "notification_intents"."purpose"::text
        else false
      end),
	CONSTRAINT "notification_intents_actor_source" CHECK (case "notification_intents"."created_by" ->> 'kind'
        when 'human' then "notification_intents"."source" in ('web', 'mobile')
        when 'agent' then "notification_intents"."source" in ('agent-rest', 'mcp')
        when 'system' then "notification_intents"."source" in ('worker', 'scheduled-job', 'webhook')
        else false
      end)
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_version" integer NOT NULL,
	"intent_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_kind" "event_kind" NOT NULL,
	"template_mode" "template_mode" NOT NULL,
	"purpose" "notification_purpose" NOT NULL,
	"event_type_version_id" uuid NOT NULL,
	"roster_snapshot_id" uuid NOT NULL,
	"roster_population" "roster_population" NOT NULL,
	"audience_config_id" uuid NOT NULL,
	"audience_config_version" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"authorization" jsonb NOT NULL,
	"channels" jsonb NOT NULL,
	"message" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"published_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_error_code" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_intent_uq" UNIQUE("intent_id"),
	CONSTRAINT "outbox_worker_anchor_uq" UNIQUE("id","intent_id","event_id","event_kind","template_mode","purpose","event_type_version_id","roster_snapshot_id","roster_population","audience_config_id","audience_config_version","request_id","authorization"),
	CONSTRAINT "outbox_message_version" CHECK ("outbox"."message_version" = 1),
	CONSTRAINT "outbox_attempts" CHECK ("outbox"."attempts" between 0 and 100),
	CONSTRAINT "outbox_classification" CHECK ((
        "outbox"."event_kind" = 'incident' and "outbox"."template_mode" = 'real'
        and "outbox"."roster_population" = 'staff'
      ) or (
        "outbox"."event_kind" = 'drill' and "outbox"."template_mode" = 'drill'
      ) or (
        "outbox"."event_kind" = 'test' and "outbox"."template_mode" = 'drill'
        and "outbox"."roster_population" = 'synthetic'
      )),
	CONSTRAINT "outbox_message_truth" CHECK (jsonb_typeof("outbox"."message") is not distinct from 'object'
        and "outbox"."message" ->> 'outboxId' is not distinct from "outbox"."id"::text
        and "outbox"."message" ->> 'intentId' is not distinct from "outbox"."intent_id"::text
        and "outbox"."message" ->> 'eventId' is not distinct from "outbox"."event_id"::text
        and "outbox"."message" ->> 'eventKind' is not distinct from "outbox"."event_kind"::text
        and "outbox"."message" ->> 'templateMode' is not distinct from "outbox"."template_mode"::text
        and "outbox"."message" ->> 'purpose' is not distinct from "outbox"."purpose"::text
        and "outbox"."message" -> 'eventTypeVersion' ->> 'id' is not distinct from "outbox"."event_type_version_id"::text
        and "outbox"."message" -> 'eventTypeVersion' ->> 'templateMode' is not distinct from "outbox"."template_mode"::text
        and "outbox"."message" ->> 'rosterSnapshotId' is not distinct from "outbox"."roster_snapshot_id"::text
        and "outbox"."message" ->> 'rosterPopulation' is not distinct from "outbox"."roster_population"::text
        and "outbox"."message" -> 'audienceConfig' ->> 'id' is not distinct from "outbox"."audience_config_id"::text
        and ("outbox"."message" -> 'audienceConfig' ->> 'version')::integer is not distinct from "outbox"."audience_config_version"
        and "outbox"."message" ->> 'requestId' is not distinct from "outbox"."request_id"::text
        and ("outbox"."message" ->> 'version')::integer is not distinct from "outbox"."message_version"
        and ("outbox"."message" ->> 'createdAt')::timestamptz is not distinct from "outbox"."created_at"
        and "outbox"."message" -> 'authorization' is not distinct from "outbox"."authorization"
        and "outbox"."message" -> 'channels' is not distinct from "outbox"."channels"),
	CONSTRAINT "outbox_channel_plan_shape" CHECK (case
        when jsonb_typeof("outbox"."channels") = 'array' then
          jsonb_array_length("outbox"."channels") between 2 and 3
          and jsonb_array_length(jsonb_path_query_array(
            "outbox"."channels", '$[*] ? (@.channel == "push" && @.renderedMessage.channel == "push" && @.integrationStatus.integrationId == "expo-push")'
          )) = 1
          and jsonb_array_length(jsonb_path_query_array(
            "outbox"."channels", '$[*] ? (@.channel == "email" && @.renderedMessage.channel == "email" && @.integrationStatus.integrationId == "ses-email")'
          )) = 1
          and jsonb_array_length(jsonb_path_query_array(
            "outbox"."channels", '$[*] ? (@.channel == "sms" && @.renderedMessage.channel == "sms" && @.integrationStatus.integrationId == "aws-eum-sms")'
          )) <= 1
          and jsonb_array_length(jsonb_path_query_array(
            "outbox"."channels", '$[*] ? (@.channel == "push" || @.channel == "email" || @.channel == "sms")'
          )) = jsonb_array_length("outbox"."channels")
        else false
      end),
	CONSTRAINT "outbox_channel_plan_classification" CHECK (case
        when "outbox"."event_kind" = 'incident' and "outbox"."template_mode" = 'real' then
          jsonb_array_length(jsonb_path_query_array(
            "outbox"."channels", '$[*] ? (@.renderedMessage.eventKind == "incident" && @.renderedMessage.templateMode == "real" && @.renderedMessage.classificationMarker == "INCIDENT")'
          )) = jsonb_array_length("outbox"."channels")
        when "outbox"."event_kind" = 'drill' and "outbox"."template_mode" = 'drill' then
          jsonb_array_length(jsonb_path_query_array(
            "outbox"."channels", '$[*] ? (@.renderedMessage.eventKind == "drill" && @.renderedMessage.templateMode == "drill" && @.renderedMessage.classificationMarker == "DRILL")'
          )) = jsonb_array_length("outbox"."channels")
        when "outbox"."event_kind" = 'test' and "outbox"."template_mode" = 'drill' then
          jsonb_array_length(jsonb_path_query_array(
            "outbox"."channels", '$[*] ? (@.renderedMessage.eventKind == "test" && @.renderedMessage.templateMode == "drill" && @.renderedMessage.classificationMarker == "DRILL")'
          )) = jsonb_array_length("outbox"."channels")
        else false
      end),
	CONSTRAINT "outbox_channel_plan_purpose" CHECK (case
        when "outbox"."purpose" = 'activation' then
          jsonb_array_length(jsonb_path_query_array(
            "outbox"."channels", '$[*] ? (@.renderedMessage.purpose == "activation")'
          )) = jsonb_array_length("outbox"."channels")
        when "outbox"."purpose" = 'all-clear' then
          jsonb_array_length(jsonb_path_query_array(
            "outbox"."channels", '$[*] ? (@.renderedMessage.purpose == "all-clear")'
          )) = jsonb_array_length("outbox"."channels")
        when "outbox"."purpose" = 'reactivation' then
          jsonb_array_length(jsonb_path_query_array(
            "outbox"."channels", '$[*] ? (@.renderedMessage.purpose == "reactivation")'
          )) = jsonb_array_length("outbox"."channels")
        else false
      end),
	CONSTRAINT "outbox_channel_plan_integration_truth" CHECK (case
        when "outbox"."roster_population" = 'staff' then
          jsonb_array_length(jsonb_path_query_array(
            "outbox"."channels", '$[*] ? (@.integrationStatus.label == "live-verified")'
          )) = jsonb_array_length("outbox"."channels")
        when "outbox"."roster_population" = 'synthetic' then
          jsonb_array_length(jsonb_path_query_array(
            "outbox"."channels", '$[*] ? (@.integrationStatus.label == "mocked")'
          )) = jsonb_array_length("outbox"."channels")
        else false
      end),
	CONSTRAINT "outbox_lock_state" CHECK (("outbox"."status" = 'processing') = ("outbox"."locked_until" is not null)),
	CONSTRAINT "outbox_published_state" CHECK (("outbox"."status" = 'published') = ("outbox"."published_at" is not null)),
	CONSTRAINT "outbox_failed_state" CHECK (("outbox"."status" = 'failed') = ("outbox"."failed_at" is not null)
        and ("outbox"."status" <> 'failed' or "outbox"."last_error_code" is not null)),
	CONSTRAINT "outbox_operational_times" CHECK ("outbox"."available_at" >= "outbox"."created_at"
        and ("outbox"."locked_until" is null or "outbox"."locked_until" >= "outbox"."created_at")
        and ("outbox"."published_at" is null or "outbox"."published_at" >= "outbox"."created_at")
        and ("outbox"."failed_at" is null or "outbox"."failed_at" >= "outbox"."created_at")),
	CONSTRAINT "outbox_last_error_code_format" CHECK ("outbox"."last_error_code" is null or "outbox"."last_error_code" ~ '^[A-Z0-9_]+$')
);
--> statement-breakpoint
CREATE TABLE "prepared_activation_consumptions" (
	"prepared_activation_id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"kind" "event_kind" NOT NULL,
	"template_mode" "template_mode" NOT NULL,
	"event_type_version_id" uuid NOT NULL,
	"roster_snapshot_id" uuid NOT NULL,
	"roster_population" "roster_population" NOT NULL,
	"audience_config_id" uuid NOT NULL,
	"audience_config_version" integer NOT NULL,
	"consequence_digest" varchar(64) NOT NULL,
	"authorization" jsonb NOT NULL,
	"request_id" uuid NOT NULL,
	"consumed_by" jsonb NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prepared_activation_consumptions_request_uq" UNIQUE("request_id"),
	CONSTRAINT "prepared_activation_consumptions_human_authorization" CHECK (("prepared_activation_consumptions"."consumed_by" ->> 'kind' = 'human'
        and "prepared_activation_consumptions"."authorization" ->> 'kind' = 'human-confirmed'
        and "prepared_activation_consumptions"."authorization" ->> 'preparedActivationId' = "prepared_activation_consumptions"."prepared_activation_id"::text
        and "prepared_activation_consumptions"."authorization" ->> 'requestId' = "prepared_activation_consumptions"."request_id"::text
        and "prepared_activation_consumptions"."authorization" ->> 'consequenceDigest' = "prepared_activation_consumptions"."consequence_digest") is true)
);
--> statement-breakpoint
CREATE TABLE "prepared_activations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activation_preview_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"kind" "event_kind" NOT NULL,
	"template_mode" "template_mode" NOT NULL,
	"event_type_version_id" uuid NOT NULL,
	"roster_snapshot_id" uuid NOT NULL,
	"roster_population" "roster_population" NOT NULL,
	"audience_config_id" uuid NOT NULL,
	"audience_config_version" integer NOT NULL,
	"consequence_digest" varchar(64) NOT NULL,
	"prepared_by" jsonb NOT NULL,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prepared_activations_preview_uq" UNIQUE("activation_preview_id"),
	CONSTRAINT "prepared_activations_consumption_anchor_uq" UNIQUE("id","facility_id","kind","template_mode","event_type_version_id","roster_snapshot_id","roster_population","audience_config_id","audience_config_version","consequence_digest"),
	CONSTRAINT "prepared_activations_staff_only" CHECK ("prepared_activations"."roster_population" = 'staff'),
	CONSTRAINT "prepared_activations_non_system_actor" CHECK (("prepared_activations"."prepared_by" ->> 'kind' in ('human', 'agent')) is true)
);
--> statement-breakpoint
CREATE TABLE "roster_endpoints" (
	"id" uuid NOT NULL,
	"roster_snapshot_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"population" "roster_population" NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"status" "endpoint_status" NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"platform" "push_platform",
	"token" text,
	"email" varchar(320),
	"phone_number" varchar(16),
	CONSTRAINT "roster_endpoints_roster_snapshot_id_id_pk" PRIMARY KEY("roster_snapshot_id","id"),
	CONSTRAINT "roster_endpoints_snapshot_recipient_identity_uq" UNIQUE("roster_snapshot_id","recipient_id","id"),
	CONSTRAINT "roster_endpoints_attempt_anchor_uq" UNIQUE("roster_snapshot_id","recipient_id","id","population","channel"),
	CONSTRAINT "roster_endpoints_valid_variant" CHECK ((
        "roster_endpoints"."channel" = 'push'
        and "roster_endpoints"."platform" is not null
        and "roster_endpoints"."token" is not null
        and length(btrim("roster_endpoints"."token")) between 16 and 4096
        and "roster_endpoints"."email" is null
        and "roster_endpoints"."phone_number" is null
      ) or (
        "roster_endpoints"."channel" = 'email'
        and "roster_endpoints"."platform" is null
        and "roster_endpoints"."token" is null
        and "roster_endpoints"."email" is not null
        and "roster_endpoints"."phone_number" is null
      ) or (
        "roster_endpoints"."channel" = 'sms'
        and "roster_endpoints"."platform" is null
        and "roster_endpoints"."token" is null
        and "roster_endpoints"."email" is null
        and "roster_endpoints"."phone_number" is not null
        and "roster_endpoints"."phone_number" ~ '^\+[1-9][0-9]{7,14}$'
      )),
	CONSTRAINT "roster_endpoints_synthetic_unroutable" CHECK ("roster_endpoints"."population" = 'staff' or (
        ("roster_endpoints"."channel" = 'push' and "roster_endpoints"."token" like 'synthetic-unroutable:%')
        or ("roster_endpoints"."channel" = 'email' and lower("roster_endpoints"."email") like '%.invalid')
        or ("roster_endpoints"."channel" = 'sms' and "roster_endpoints"."phone_number" ~ '^\+120255501[0-9]{2}$')
      ))
);
--> statement-breakpoint
CREATE TABLE "roster_recipient_group_sources" (
	"roster_snapshot_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"population" "roster_population" NOT NULL,
	"group_source_id" uuid NOT NULL,
	"group_source_kind" "group_source_kind" NOT NULL,
	"group_purpose" "group_purpose" NOT NULL,
	CONSTRAINT "roster_recipient_group_sources_roster_snapshot_id_recipient_id_group_source_id_pk" PRIMARY KEY("roster_snapshot_id","recipient_id","group_source_id"),
	CONSTRAINT "roster_recipient_group_sources_population_source" CHECK ((
        "roster_recipient_group_sources"."population" = 'staff' and "roster_recipient_group_sources"."group_source_kind" = 'google-group'
      ) or (
        "roster_recipient_group_sources"."population" = 'synthetic' and "roster_recipient_group_sources"."group_source_kind" = 'synthetic'
      )),
	CONSTRAINT "roster_recipient_group_sources_non_access" CHECK ("roster_recipient_group_sources"."group_purpose" in ('building', 'others'))
);
--> statement-breakpoint
CREATE TABLE "roster_recipients" (
	"id" uuid NOT NULL,
	"roster_snapshot_id" uuid NOT NULL,
	"population" "roster_population" NOT NULL,
	"google_subject" varchar(255),
	"display_name" varchar(160) NOT NULL,
	CONSTRAINT "roster_recipients_roster_snapshot_id_id_pk" PRIMARY KEY("roster_snapshot_id","id"),
	CONSTRAINT "roster_recipients_snapshot_subject_uq" UNIQUE("roster_snapshot_id","google_subject"),
	CONSTRAINT "roster_recipients_snapshot_identity_population_uq" UNIQUE("roster_snapshot_id","id","population"),
	CONSTRAINT "roster_recipients_population_subject" CHECK ((
        "roster_recipients"."population" = 'staff' and "roster_recipients"."google_subject" is not null
      ) or (
        "roster_recipients"."population" = 'synthetic' and "roster_recipients"."google_subject" is null
      ))
);
--> statement-breakpoint
CREATE TABLE "roster_snapshot_facilities" (
	"roster_snapshot_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	CONSTRAINT "roster_snapshot_facilities_roster_snapshot_id_facility_id_pk" PRIMARY KEY("roster_snapshot_id","facility_id")
);
--> statement-breakpoint
CREATE TABLE "roster_snapshot_sources" (
	"roster_snapshot_id" uuid NOT NULL,
	"population" "roster_population" NOT NULL,
	"group_source_id" uuid NOT NULL,
	"group_source_kind" "group_source_kind" NOT NULL,
	"group_purpose" "group_purpose" NOT NULL,
	"completion_kind" "group_completion_kind" NOT NULL,
	CONSTRAINT "roster_snapshot_sources_roster_snapshot_id_group_source_id_completion_kind_pk" PRIMARY KEY("roster_snapshot_id","group_source_id","completion_kind"),
	CONSTRAINT "roster_snapshot_sources_population_source" CHECK ((
        "roster_snapshot_sources"."population" = 'staff' and "roster_snapshot_sources"."group_source_kind" = 'google-group'
      ) or (
        "roster_snapshot_sources"."population" = 'synthetic' and "roster_snapshot_sources"."group_source_kind" = 'synthetic'
      )),
	CONSTRAINT "roster_snapshot_sources_non_access" CHECK ("roster_snapshot_sources"."group_purpose" in ('building', 'others'))
);
--> statement-breakpoint
CREATE TABLE "roster_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"population" "roster_population" NOT NULL,
	"complete" boolean NOT NULL,
	"source_configuration_id" uuid NOT NULL,
	"source_configuration_version" integer NOT NULL,
	"sync_started_at" timestamp with time zone NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	CONSTRAINT "roster_snapshots_version_population_uq" UNIQUE("version","population"),
	CONSTRAINT "roster_snapshots_identity_population_uq" UNIQUE("id","population"),
	CONSTRAINT "roster_snapshots_complete_true" CHECK ("roster_snapshots"."complete" = true),
	CONSTRAINT "roster_snapshots_version_positive" CHECK ("roster_snapshots"."version" > 0),
	CONSTRAINT "roster_snapshots_capture_time" CHECK ("roster_snapshots"."captured_at" >= "roster_snapshots"."sync_started_at")
);
--> statement-breakpoint
CREATE TABLE "roster_source_configuration_facilities" (
	"configuration_id" uuid NOT NULL,
	"configuration_version" integer NOT NULL,
	"facility_id" uuid NOT NULL,
	CONSTRAINT "roster_source_configuration_facilities_configuration_id_configuration_version_facility_id_pk" PRIMARY KEY("configuration_id","configuration_version","facility_id")
);
--> statement-breakpoint
CREATE TABLE "roster_source_configuration_groups" (
	"configuration_id" uuid NOT NULL,
	"configuration_version" integer NOT NULL,
	"population" "roster_population" NOT NULL,
	"group_source_id" uuid NOT NULL,
	"group_source_kind" "group_source_kind" NOT NULL,
	"group_purpose" "group_purpose" NOT NULL,
	CONSTRAINT "roster_source_configuration_groups_configuration_id_configuration_version_group_source_id_pk" PRIMARY KEY("configuration_id","configuration_version","group_source_id"),
	CONSTRAINT "roster_source_configuration_groups_population_source" CHECK ((
        "roster_source_configuration_groups"."population" = 'staff' and "roster_source_configuration_groups"."group_source_kind" = 'google-group'
      ) or (
        "roster_source_configuration_groups"."population" = 'synthetic' and "roster_source_configuration_groups"."group_source_kind" = 'synthetic'
      )),
	CONSTRAINT "roster_source_configuration_groups_non_access" CHECK ("roster_source_configuration_groups"."group_purpose" in ('building', 'others'))
);
--> statement-breakpoint
CREATE TABLE "roster_source_configurations" (
	"id" uuid NOT NULL,
	"version" integer NOT NULL,
	"population" "roster_population" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_source_configurations_id_version_pk" PRIMARY KEY("id","version"),
	CONSTRAINT "roster_source_configurations_identity_population_uq" UNIQUE("id","version","population"),
	CONSTRAINT "roster_source_configurations_version_positive" CHECK ("roster_source_configurations"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "roster_sync_group_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_result_id" uuid NOT NULL,
	"population" "roster_population" NOT NULL,
	"group_source_id" uuid NOT NULL,
	"group_source_kind" "group_source_kind" NOT NULL,
	"group_purpose" "group_purpose" NOT NULL,
	"expected_set_kind" "group_completion_kind" DEFAULT 'expected' NOT NULL,
	"error_code" varchar(100) NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "roster_sync_group_failures_expected_marker" CHECK ("roster_sync_group_failures"."expected_set_kind" = 'expected'),
	CONSTRAINT "roster_sync_group_failures_error_format" CHECK ("roster_sync_group_failures"."error_code" ~ '^[A-Z0-9_]+$')
);
--> statement-breakpoint
CREATE TABLE "roster_sync_result_sources" (
	"sync_result_id" uuid NOT NULL,
	"population" "roster_population" NOT NULL,
	"group_source_id" uuid NOT NULL,
	"group_source_kind" "group_source_kind" NOT NULL,
	"group_purpose" "group_purpose" NOT NULL,
	"set_kind" "group_completion_kind" NOT NULL,
	"expected_set_kind" "group_completion_kind" DEFAULT 'expected' NOT NULL,
	CONSTRAINT "roster_sync_result_sources_sync_result_id_population_group_source_id_group_source_kind_group_purpose_set_kind_pk" PRIMARY KEY("sync_result_id","population","group_source_id","group_source_kind","group_purpose","set_kind"),
	CONSTRAINT "roster_sync_result_sources_expected_marker" CHECK ("roster_sync_result_sources"."expected_set_kind" = 'expected'),
	CONSTRAINT "roster_sync_result_sources_population_source" CHECK ((
        "roster_sync_result_sources"."population" = 'staff' and "roster_sync_result_sources"."group_source_kind" = 'google-group'
      ) or (
        "roster_sync_result_sources"."population" = 'synthetic' and "roster_sync_result_sources"."group_source_kind" = 'synthetic'
      )),
	CONSTRAINT "roster_sync_result_sources_non_access" CHECK ("roster_sync_result_sources"."group_purpose" in ('building', 'others'))
);
--> statement-breakpoint
CREATE TABLE "roster_sync_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_configuration_id" uuid NOT NULL,
	"source_configuration_version" integer NOT NULL,
	"population" "roster_population" NOT NULL,
	"outcome" "roster_sync_outcome" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"expected_source_count" integer NOT NULL,
	"completed_source_count" integer NOT NULL,
	"group_failure_count" integer NOT NULL,
	"published_snapshot_id" uuid,
	CONSTRAINT "roster_sync_results_identity_population_uq" UNIQUE("id","population"),
	CONSTRAINT "roster_sync_results_times" CHECK ("roster_sync_results"."completed_at" >= "roster_sync_results"."started_at"),
	CONSTRAINT "roster_sync_results_counts" CHECK ("roster_sync_results"."expected_source_count" between 1 and 500
        and "roster_sync_results"."completed_source_count" between 0 and "roster_sync_results"."expected_source_count"
        and "roster_sync_results"."group_failure_count" between 0 and 500),
	CONSTRAINT "roster_sync_results_publish_truth" CHECK ((
        "roster_sync_results"."outcome" = 'complete'
        and "roster_sync_results"."published_snapshot_id" is not null
        and "roster_sync_results"."completed_source_count" = "roster_sync_results"."expected_source_count"
        and "roster_sync_results"."group_failure_count" = 0
      ) or (
        "roster_sync_results"."outcome" in ('failed', 'partial-rejected')
        and "roster_sync_results"."published_snapshot_id" is null
      ))
);
--> statement-breakpoint
CREATE TABLE "security_audit_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" integer NOT NULL,
	"previous_hash" varchar(64),
	"entry_hash" varchar(64) NOT NULL,
	"category" "security_audit_category" NOT NULL,
	"action" varchar(120) NOT NULL,
	"action_ids" jsonb NOT NULL,
	"confirmation_id" uuid,
	"outcome" "security_audit_outcome" NOT NULL,
	"principal_kind" varchar(32) NOT NULL,
	"principal" jsonb NOT NULL,
	"source" "invocation_source" NOT NULL,
	"facility_id" uuid,
	"target_kind" varchar(32),
	"target_id" varchar(255),
	"request_id" uuid NOT NULL,
	"reason_code" varchar(100),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_audit_entries_sequence_positive" CHECK ("security_audit_entries"."sequence" > 0),
	CONSTRAINT "security_audit_entries_hash_chain" CHECK (("security_audit_entries"."sequence" = 1) = ("security_audit_entries"."previous_hash" is null)),
	CONSTRAINT "security_audit_entries_hash_format" CHECK ("security_audit_entries"."entry_hash" ~ '^[a-f0-9]{64}$'
        and ("security_audit_entries"."previous_hash" is null or "security_audit_entries"."previous_hash" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "security_audit_entries_action_format" CHECK ("security_audit_entries"."action" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
	CONSTRAINT "security_audit_entries_principal_kind" CHECK ("security_audit_entries"."principal_kind" in ('human', 'agent', 'system', 'unauthenticated')),
	CONSTRAINT "security_audit_entries_target_pair" CHECK (("security_audit_entries"."target_kind" is null) = ("security_audit_entries"."target_id" is null)),
	CONSTRAINT "security_audit_entries_outcome_reason" CHECK (("security_audit_entries"."outcome" = 'success') = ("security_audit_entries"."reason_code" is null))
);
--> statement-breakpoint
CREATE TABLE "session_revocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"revoked_by" jsonb NOT NULL,
	"reason_code" varchar(100) NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_revocations_reason_format" CHECK ("session_revocations"."reason_code" ~ '^[A-Z0-9_]+$')
);
--> statement-breakpoint
CREATE TABLE "session_token_issuances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"token_digest" varchar(64) NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_issuances_session_uq" UNIQUE("session_id"),
	CONSTRAINT "session_token_issuances_digest_uq" UNIQUE("token_digest"),
	CONSTRAINT "session_token_issuances_digest_format" CHECK ("session_token_issuances"."token_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "session_token_replays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"rotation_id" uuid NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_token_rotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"previous_token_digest" varchar(64) NOT NULL,
	"next_token_digest" varchar(64) NOT NULL,
	"rotated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_rotations_identity_session_uq" UNIQUE("id","session_id"),
	CONSTRAINT "session_token_rotations_previous_uq" UNIQUE("previous_token_digest"),
	CONSTRAINT "session_token_rotations_next_uq" UNIQUE("next_token_digest"),
	CONSTRAINT "session_token_rotations_changed" CHECK ("session_token_rotations"."previous_token_digest" <> "session_token_rotations"."next_token_digest"),
	CONSTRAINT "session_token_rotations_digest_format" CHECK ("session_token_rotations"."previous_token_digest" ~ '^[a-f0-9]{64}$'
        and "session_token_rotations"."next_token_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_enrollment_id" uuid NOT NULL,
	"membership_snapshot_id" uuid NOT NULL,
	"membership_valid_until" timestamp with time zone NOT NULL,
	"membership_grace_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_identity_user_uq" UNIQUE("id","user_id"),
	CONSTRAINT "sessions_lifecycle_times" CHECK ("sessions"."expires_at" >= "sessions"."created_at"
        and "sessions"."membership_valid_until" >= "sessions"."created_at"
        and "sessions"."membership_grace_until" >= "sessions"."membership_valid_until"
        and ("sessions"."revoked_at" is null or "sessions"."revoked_at" >= "sessions"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "sms_opt_out_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"roster_snapshot_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"population" "roster_population" NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"provider" varchar(100) NOT NULL,
	"provider_reference" varchar(500) NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_opt_out_records_sms_only" CHECK ("sms_opt_out_records"."channel" = 'sms')
);
--> statement-breakpoint
CREATE TABLE "user_facility_scopes" (
	"user_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	CONSTRAINT "user_facility_scopes_user_id_facility_id_pk" PRIMARY KEY("user_id","facility_id")
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	CONSTRAINT "user_roles_user_id_role_pk" PRIMARY KEY("user_id","role")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"google_subject" varchar(255) NOT NULL,
	"email" varchar(320) NOT NULL,
	"display_name" varchar(160) NOT NULL,
	"facility_scope_kind" "facility_scope_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "users_psd_email" CHECK (lower("users"."email") like '%@psd401.net'),
	CONSTRAINT "users_disabled_after_creation" CHECK ("users"."disabled_at" is null or "users"."disabled_at" >= "users"."created_at")
);
--> statement-breakpoint
ALTER TABLE "access_membership_member_facilities" ADD CONSTRAINT "access_membership_member_facilities_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_membership_member_facilities" ADD CONSTRAINT "access_membership_member_facilities_member_fk" FOREIGN KEY ("snapshot_id","user_id") REFERENCES "public"."access_membership_members"("snapshot_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_membership_member_groups" ADD CONSTRAINT "access_membership_member_groups_member_fk" FOREIGN KEY ("snapshot_id","user_id") REFERENCES "public"."access_membership_members"("snapshot_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_membership_member_groups" ADD CONSTRAINT "access_membership_member_groups_access_source_fk" FOREIGN KEY ("group_source_id","group_source_kind","group_purpose") REFERENCES "public"."group_sources"("id","kind","purpose") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_membership_members" ADD CONSTRAINT "access_membership_members_snapshot_id_access_membership_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."access_membership_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_membership_members" ADD CONSTRAINT "access_membership_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_membership_snapshot_groups" ADD CONSTRAINT "access_membership_snapshot_groups_snapshot_id_access_membership_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."access_membership_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_membership_snapshot_groups" ADD CONSTRAINT "access_membership_snapshot_groups_access_source_fk" FOREIGN KEY ("group_source_id","group_source_kind","group_purpose") REFERENCES "public"."group_sources"("id","kind","purpose") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activation_previews" ADD CONSTRAINT "activation_previews_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activation_previews" ADD CONSTRAINT "activation_previews_event_type_mode_fk" FOREIGN KEY ("event_type_version_id","template_mode") REFERENCES "public"."event_type_versions"("id","template_mode") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activation_previews" ADD CONSTRAINT "activation_previews_roster_population_fk" FOREIGN KEY ("roster_snapshot_id","roster_population") REFERENCES "public"."roster_snapshots"("id","population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activation_previews" ADD CONSTRAINT "activation_previews_audience_fk" FOREIGN KEY ("audience_config_id","audience_config_version") REFERENCES "public"."audience_configurations"("id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_api_key_facilities" ADD CONSTRAINT "agent_api_key_facilities_api_key_id_agent_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."agent_api_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_api_key_facilities" ADD CONSTRAINT "agent_api_key_facilities_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_api_key_grants" ADD CONSTRAINT "agent_api_key_grants_api_key_id_agent_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."agent_api_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_api_key_revocations" ADD CONSTRAINT "agent_api_key_revocations_api_key_id_agent_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."agent_api_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_api_key_revocations" ADD CONSTRAINT "agent_api_key_revocations_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD CONSTRAINT "agent_api_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD CONSTRAINT "agent_api_keys_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audience_configurations" ADD CONSTRAINT "audience_configurations_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audience_targets" ADD CONSTRAINT "audience_targets_target_facility_id_facilities_id_fk" FOREIGN KEY ("target_facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audience_targets" ADD CONSTRAINT "audience_targets_group_source_id_group_sources_id_fk" FOREIGN KEY ("group_source_id") REFERENCES "public"."group_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audience_targets" ADD CONSTRAINT "audience_targets_configuration_fk" FOREIGN KEY ("audience_config_id","audience_config_version") REFERENCES "public"."audience_configurations"("id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audience_targets" ADD CONSTRAINT "audience_targets_neighborhood_fk" FOREIGN KEY ("neighborhood_id","neighborhood_version") REFERENCES "public"."neighborhood_versions"("id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_attempts" ADD CONSTRAINT "channel_attempts_batch_id_dispatch_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."dispatch_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_attempts" ADD CONSTRAINT "channel_attempts_intent_id_notification_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."notification_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_attempts" ADD CONSTRAINT "channel_attempts_notification_intent_truth_fk" FOREIGN KEY ("intent_id","event_id","event_kind","template_mode","purpose","event_type_version_id","roster_snapshot_id","roster_population") REFERENCES "public"."notification_intents"("id","event_id","event_kind","template_mode","purpose","event_type_version_id","roster_snapshot_id","roster_population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_attempts" ADD CONSTRAINT "channel_attempts_dispatch_batch_truth_fk" FOREIGN KEY ("batch_id","intent_id","event_id","event_kind","template_mode","purpose","event_type_version_id","roster_snapshot_id","roster_population","channel") REFERENCES "public"."dispatch_batches"("id","intent_id","event_id","event_kind","template_mode","purpose","event_type_version_id","roster_snapshot_id","roster_population","channel") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_attempts" ADD CONSTRAINT "channel_attempts_event_targeting_fk" FOREIGN KEY ("event_id","event_kind","template_mode","roster_population") REFERENCES "public"."events"("id","kind","template_mode","roster_population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_attempts" ADD CONSTRAINT "channel_attempts_event_type_mode_fk" FOREIGN KEY ("event_type_version_id","template_mode") REFERENCES "public"."event_type_versions"("id","template_mode") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_attempts" ADD CONSTRAINT "channel_attempts_roster_population_fk" FOREIGN KEY ("roster_snapshot_id","roster_population") REFERENCES "public"."roster_snapshots"("id","population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_attempts" ADD CONSTRAINT "channel_attempts_endpoint_fk" FOREIGN KEY ("roster_snapshot_id","recipient_id","endpoint_id","roster_population","channel") REFERENCES "public"."roster_endpoints"("roster_snapshot_id","recipient_id","id","population","channel") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_configurations" ADD CONSTRAINT "channel_configurations_status_truth_fk" FOREIGN KEY ("status_id","integration_id","status_label") REFERENCES "public"."integration_statuses"("id","integration_id","label") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectivity_epoch_invalidations" ADD CONSTRAINT "connectivity_epoch_invalidations_connectivity_epoch_id_connectivity_epochs_id_fk" FOREIGN KEY ("connectivity_epoch_id") REFERENCES "public"."connectivity_epochs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectivity_epochs" ADD CONSTRAINT "connectivity_epochs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_evidence" ADD CONSTRAINT "delivery_evidence_intent_id_notification_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."notification_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_evidence" ADD CONSTRAINT "delivery_evidence_attempt_id_channel_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."channel_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_evidence" ADD CONSTRAINT "delivery_evidence_previous_same_subject_fk" FOREIGN KEY ("previous_evidence_id","subject_kind","subject_id") REFERENCES "public"."delivery_evidence"("id","subject_kind","subject_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_enrollments" ADD CONSTRAINT "device_enrollments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_push_token_registrations" ADD CONSTRAINT "device_push_token_registrations_device_platform_fk" FOREIGN KEY ("device_enrollment_id","platform") REFERENCES "public"."device_enrollments"("id","platform") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_push_token_unregistrations" ADD CONSTRAINT "device_push_token_unregistrations_registration_device_fk" FOREIGN KEY ("registration_id","device_enrollment_id") REFERENCES "public"."device_push_token_registrations"("id","device_enrollment_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_batches" ADD CONSTRAINT "dispatch_batches_outbox_id_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."outbox"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_batches" ADD CONSTRAINT "dispatch_batches_intent_id_notification_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."notification_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_batches" ADD CONSTRAINT "dispatch_batches_notification_intent_truth_fk" FOREIGN KEY ("intent_id","event_id","event_kind","template_mode","purpose","event_type_version_id","roster_snapshot_id","roster_population","audience_config_id","audience_config_version","request_id","authorization") REFERENCES "public"."notification_intents"("id","event_id","event_kind","template_mode","purpose","event_type_version_id","roster_snapshot_id","roster_population","audience_config_id","audience_config_version","request_id","authorization") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_batches" ADD CONSTRAINT "dispatch_batches_outbox_truth_fk" FOREIGN KEY ("outbox_id","intent_id","event_id","event_kind","template_mode","purpose","event_type_version_id","roster_snapshot_id","roster_population","audience_config_id","audience_config_version","request_id","authorization") REFERENCES "public"."outbox"("id","intent_id","event_id","event_kind","template_mode","purpose","event_type_version_id","roster_snapshot_id","roster_population","audience_config_id","audience_config_version","request_id","authorization") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_batches" ADD CONSTRAINT "dispatch_batches_event_targeting_fk" FOREIGN KEY ("event_id","event_kind","template_mode","roster_population") REFERENCES "public"."events"("id","kind","template_mode","roster_population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_batches" ADD CONSTRAINT "dispatch_batches_event_type_mode_fk" FOREIGN KEY ("event_type_version_id","template_mode") REFERENCES "public"."event_type_versions"("id","template_mode") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_batches" ADD CONSTRAINT "dispatch_batches_roster_population_fk" FOREIGN KEY ("roster_snapshot_id","roster_population") REFERENCES "public"."roster_snapshots"("id","population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_batches" ADD CONSTRAINT "dispatch_batches_audience_fk" FOREIGN KEY ("audience_config_id","audience_config_version") REFERENCES "public"."audience_configurations"("id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_batches" ADD CONSTRAINT "dispatch_batches_integration_truth_fk" FOREIGN KEY ("integration_status_id","integration_id","integration_label") REFERENCES "public"."integration_statuses"("id","integration_id","label") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_status_records" ADD CONSTRAINT "endpoint_status_records_endpoint_fk" FOREIGN KEY ("roster_snapshot_id","recipient_id","endpoint_id","population","channel") REFERENCES "public"."roster_endpoints"("roster_snapshot_id","recipient_id","id","population","channel") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_transitions" ADD CONSTRAINT "event_transitions_confirmation_id_human_confirmation_records_id_fk" FOREIGN KEY ("confirmation_id") REFERENCES "public"."human_confirmation_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_transitions" ADD CONSTRAINT "event_transitions_event_targeting_fk" FOREIGN KEY ("event_id","kind","template_mode","roster_population") REFERENCES "public"."events"("id","kind","template_mode","roster_population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_transitions" ADD CONSTRAINT "event_transitions_source_event_targeting_fk" FOREIGN KEY ("source_event_id","kind","template_mode","roster_population") REFERENCES "public"."events"("id","kind","template_mode","roster_population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_transitions" ADD CONSTRAINT "event_transitions_correction_event_classification_fk" FOREIGN KEY ("correction_event_id","kind","template_mode") REFERENCES "public"."events"("id","kind","template_mode") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_transitions" ADD CONSTRAINT "event_transitions_journal_event_fk" FOREIGN KEY ("journal_event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_transitions" ADD CONSTRAINT "event_transitions_consumed_confirmation_fk" FOREIGN KEY ("confirmation_id","confirmation_status","request_id","consequence_digest") REFERENCES "public"."human_confirmation_records"("id","status","consumed_for_request_id","consequence_digest") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_type_draft_templates" ADD CONSTRAINT "event_type_draft_templates_draft_mode_fk" FOREIGN KEY ("event_type_version_draft_id","template_mode") REFERENCES "public"."event_type_version_drafts"("id","template_mode") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_type_templates" ADD CONSTRAINT "event_type_templates_version_mode_fk" FOREIGN KEY ("event_type_version_id","template_mode") REFERENCES "public"."event_type_versions"("id","template_mode") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_type_version_drafts" ADD CONSTRAINT "event_type_version_drafts_type_mode_fk" FOREIGN KEY ("event_type_id","template_mode") REFERENCES "public"."event_types"("id","template_mode") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_type_versions" ADD CONSTRAINT "event_type_versions_type_mode_fk" FOREIGN KEY ("event_type_id","template_mode") REFERENCES "public"."event_types"("id","template_mode") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_type_versions" ADD CONSTRAINT "event_type_versions_supersedes_mode_fk" FOREIGN KEY ("supersedes_version_id","template_mode") REFERENCES "public"."event_type_versions"("id","template_mode") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_event_type_mode_fk" FOREIGN KEY ("event_type_version_id","template_mode") REFERENCES "public"."event_type_versions"("id","template_mode") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_roster_population_fk" FOREIGN KEY ("roster_snapshot_id","roster_population") REFERENCES "public"."roster_snapshots"("id","population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_correction_source_classification_fk" FOREIGN KEY ("correction_of_event_id","kind","template_mode") REFERENCES "public"."events"("id","kind","template_mode") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_sources" ADD CONSTRAINT "group_sources_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_confirmation_actions" ADD CONSTRAINT "human_confirmation_actions_confirmation_id_human_confirmation_records_id_fk" FOREIGN KEY ("confirmation_id") REFERENCES "public"."human_confirmation_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_confirmation_records" ADD CONSTRAINT "human_confirmation_records_epoch_session_fk" FOREIGN KEY ("connectivity_epoch_id","confirmed_with_session_id") REFERENCES "public"."connectivity_epochs"("id","session_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_confirmation_records" ADD CONSTRAINT "human_confirmation_records_session_user_fk" FOREIGN KEY ("confirmed_with_session_id","confirmed_by_user_id") REFERENCES "public"."sessions"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_statuses" ADD CONSTRAINT "integration_statuses_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_supersedes_same_event_fk" FOREIGN KEY ("event_id","supersedes_entry_id","supersedes_entry_sequence") REFERENCES "public"."journal_entries"("event_id","id","sequence") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_media_event_fk" FOREIGN KEY ("media_id","event_id") REFERENCES "public"."media_records"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_transition_event_fk" FOREIGN KEY ("transition_id","event_id") REFERENCES "public"."event_transitions"("id","journal_event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_consequence_previews" ADD CONSTRAINT "lifecycle_consequence_previews_event_targeting_fk" FOREIGN KEY ("event_id","kind","template_mode","roster_population") REFERENCES "public"."events"("id","kind","template_mode","roster_population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_consequence_previews" ADD CONSTRAINT "lifecycle_consequence_previews_event_type_mode_fk" FOREIGN KEY ("event_type_version_id","template_mode") REFERENCES "public"."event_type_versions"("id","template_mode") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_consequence_previews" ADD CONSTRAINT "lifecycle_consequence_previews_roster_population_fk" FOREIGN KEY ("roster_snapshot_id","roster_population") REFERENCES "public"."roster_snapshots"("id","population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_consequence_previews" ADD CONSTRAINT "lifecycle_consequence_previews_audience_fk" FOREIGN KEY ("audience_config_id","audience_config_version") REFERENCES "public"."audience_configurations"("id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_records" ADD CONSTRAINT "media_records_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_records" ADD CONSTRAINT "media_records_upload_intent_event_fk" FOREIGN KEY ("upload_intent_id","event_id") REFERENCES "public"."media_upload_intents"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_upload_intents" ADD CONSTRAINT "media_upload_intents_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "neighborhood_facilities" ADD CONSTRAINT "neighborhood_facilities_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "neighborhood_facilities" ADD CONSTRAINT "neighborhood_facilities_version_fk" FOREIGN KEY ("neighborhood_id","neighborhood_version") REFERENCES "public"."neighborhood_versions"("id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intent_channels" ADD CONSTRAINT "notification_intent_channels_intent_id_notification_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."notification_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intent_channels" ADD CONSTRAINT "notification_intent_channels_intent_truth_fk" FOREIGN KEY ("intent_id","event_kind","template_mode","purpose","roster_population") REFERENCES "public"."notification_intents"("id","event_kind","template_mode","purpose","roster_population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intent_channels" ADD CONSTRAINT "notification_intent_channels_integration_truth_fk" FOREIGN KEY ("integration_status_id","integration_id","integration_label") REFERENCES "public"."integration_statuses"("id","integration_id","label") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_event_targeting_fk" FOREIGN KEY ("event_id","event_kind","template_mode","roster_population") REFERENCES "public"."events"("id","kind","template_mode","roster_population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_event_type_mode_fk" FOREIGN KEY ("event_type_version_id","template_mode") REFERENCES "public"."event_type_versions"("id","template_mode") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_roster_population_fk" FOREIGN KEY ("roster_snapshot_id","roster_population") REFERENCES "public"."roster_snapshots"("id","population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_audience_fk" FOREIGN KEY ("audience_config_id","audience_config_version") REFERENCES "public"."audience_configurations"("id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_intent_id_notification_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."notification_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_notification_intent_truth_fk" FOREIGN KEY ("intent_id","event_id","event_kind","template_mode","purpose","event_type_version_id","roster_snapshot_id","roster_population","audience_config_id","audience_config_version","request_id","authorization") REFERENCES "public"."notification_intents"("id","event_id","event_kind","template_mode","purpose","event_type_version_id","roster_snapshot_id","roster_population","audience_config_id","audience_config_version","request_id","authorization") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_event_targeting_fk" FOREIGN KEY ("event_id","event_kind","template_mode","roster_population") REFERENCES "public"."events"("id","kind","template_mode","roster_population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_event_type_mode_fk" FOREIGN KEY ("event_type_version_id","template_mode") REFERENCES "public"."event_type_versions"("id","template_mode") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_roster_population_fk" FOREIGN KEY ("roster_snapshot_id","roster_population") REFERENCES "public"."roster_snapshots"("id","population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_audience_fk" FOREIGN KEY ("audience_config_id","audience_config_version") REFERENCES "public"."audience_configurations"("id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepared_activation_consumptions" ADD CONSTRAINT "prepared_activation_consumptions_preparation_truth_fk" FOREIGN KEY ("prepared_activation_id","facility_id","kind","template_mode","event_type_version_id","roster_snapshot_id","roster_population","audience_config_id","audience_config_version","consequence_digest") REFERENCES "public"."prepared_activations"("id","facility_id","kind","template_mode","event_type_version_id","roster_snapshot_id","roster_population","audience_config_id","audience_config_version","consequence_digest") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepared_activation_consumptions" ADD CONSTRAINT "prepared_activation_consumptions_event_truth_fk" FOREIGN KEY ("event_id","facility_id","kind","template_mode","event_type_version_id","roster_snapshot_id","roster_population") REFERENCES "public"."events"("id","facility_id","kind","template_mode","event_type_version_id","roster_snapshot_id","roster_population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepared_activations" ADD CONSTRAINT "prepared_activations_preview_truth_fk" FOREIGN KEY ("activation_preview_id","facility_id","kind","template_mode","event_type_version_id","roster_snapshot_id","roster_population","audience_config_id","audience_config_version","consequence_digest") REFERENCES "public"."activation_previews"("id","facility_id","kind","template_mode","event_type_version_id","roster_snapshot_id","roster_population","audience_config_id","audience_config_version","consequence_digest") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_endpoints" ADD CONSTRAINT "roster_endpoints_recipient_fk" FOREIGN KEY ("roster_snapshot_id","recipient_id","population") REFERENCES "public"."roster_recipients"("roster_snapshot_id","id","population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_recipient_group_sources" ADD CONSTRAINT "roster_recipient_group_sources_recipient_fk" FOREIGN KEY ("roster_snapshot_id","recipient_id","population") REFERENCES "public"."roster_recipients"("roster_snapshot_id","id","population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_recipient_group_sources" ADD CONSTRAINT "roster_recipient_group_sources_source_fk" FOREIGN KEY ("group_source_id","group_source_kind","group_purpose") REFERENCES "public"."group_sources"("id","kind","purpose") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_recipients" ADD CONSTRAINT "roster_recipients_roster_snapshot_id_roster_snapshots_id_fk" FOREIGN KEY ("roster_snapshot_id") REFERENCES "public"."roster_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_recipients" ADD CONSTRAINT "roster_recipients_snapshot_population_fk" FOREIGN KEY ("roster_snapshot_id","population") REFERENCES "public"."roster_snapshots"("id","population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_snapshot_facilities" ADD CONSTRAINT "roster_snapshot_facilities_roster_snapshot_id_roster_snapshots_id_fk" FOREIGN KEY ("roster_snapshot_id") REFERENCES "public"."roster_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_snapshot_facilities" ADD CONSTRAINT "roster_snapshot_facilities_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_snapshot_sources" ADD CONSTRAINT "roster_snapshot_sources_snapshot_population_fk" FOREIGN KEY ("roster_snapshot_id","population") REFERENCES "public"."roster_snapshots"("id","population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_snapshot_sources" ADD CONSTRAINT "roster_snapshot_sources_source_fk" FOREIGN KEY ("group_source_id","group_source_kind","group_purpose") REFERENCES "public"."group_sources"("id","kind","purpose") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_snapshots" ADD CONSTRAINT "roster_snapshots_configuration_population_fk" FOREIGN KEY ("source_configuration_id","source_configuration_version","population") REFERENCES "public"."roster_source_configurations"("id","version","population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_source_configuration_facilities" ADD CONSTRAINT "roster_source_configuration_facilities_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_source_configuration_facilities" ADD CONSTRAINT "roster_source_configuration_facilities_configuration_fk" FOREIGN KEY ("configuration_id","configuration_version") REFERENCES "public"."roster_source_configurations"("id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_source_configuration_groups" ADD CONSTRAINT "roster_source_configuration_groups_configuration_fk" FOREIGN KEY ("configuration_id","configuration_version","population") REFERENCES "public"."roster_source_configurations"("id","version","population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_source_configuration_groups" ADD CONSTRAINT "roster_source_configuration_groups_source_fk" FOREIGN KEY ("group_source_id","group_source_kind","group_purpose") REFERENCES "public"."group_sources"("id","kind","purpose") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_sync_group_failures" ADD CONSTRAINT "roster_sync_group_failures_expected_source_fk" FOREIGN KEY ("sync_result_id","population","group_source_id","group_source_kind","group_purpose","expected_set_kind") REFERENCES "public"."roster_sync_result_sources"("sync_result_id","population","group_source_id","group_source_kind","group_purpose","set_kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_sync_result_sources" ADD CONSTRAINT "roster_sync_result_sources_result_population_fk" FOREIGN KEY ("sync_result_id","population") REFERENCES "public"."roster_sync_results"("id","population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_sync_result_sources" ADD CONSTRAINT "roster_sync_result_sources_group_source_fk" FOREIGN KEY ("group_source_id","group_source_kind","group_purpose") REFERENCES "public"."group_sources"("id","kind","purpose") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_sync_result_sources" ADD CONSTRAINT "roster_sync_result_sources_completed_expected_fk" FOREIGN KEY ("sync_result_id","population","group_source_id","group_source_kind","group_purpose","expected_set_kind") REFERENCES "public"."roster_sync_result_sources"("sync_result_id","population","group_source_id","group_source_kind","group_purpose","set_kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_sync_results" ADD CONSTRAINT "roster_sync_results_configuration_population_fk" FOREIGN KEY ("source_configuration_id","source_configuration_version","population") REFERENCES "public"."roster_source_configurations"("id","version","population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_sync_results" ADD CONSTRAINT "roster_sync_results_published_snapshot_population_fk" FOREIGN KEY ("published_snapshot_id","population") REFERENCES "public"."roster_snapshots"("id","population") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_audit_entries" ADD CONSTRAINT "security_audit_entries_confirmation_id_human_confirmation_records_id_fk" FOREIGN KEY ("confirmation_id") REFERENCES "public"."human_confirmation_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_audit_entries" ADD CONSTRAINT "security_audit_entries_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_revocations" ADD CONSTRAINT "session_revocations_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_token_issuances" ADD CONSTRAINT "session_token_issuances_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_token_replays" ADD CONSTRAINT "session_token_replays_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_token_replays" ADD CONSTRAINT "session_token_replays_rotation_session_fk" FOREIGN KEY ("rotation_id","session_id") REFERENCES "public"."session_token_rotations"("id","session_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_token_rotations" ADD CONSTRAINT "session_token_rotations_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_enrollment_id_device_enrollments_id_fk" FOREIGN KEY ("device_enrollment_id") REFERENCES "public"."device_enrollments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_membership_snapshot_id_access_membership_snapshots_id_fk" FOREIGN KEY ("membership_snapshot_id") REFERENCES "public"."access_membership_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_user_fk" FOREIGN KEY ("device_enrollment_id","user_id") REFERENCES "public"."device_enrollments"("id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_membership_user_fk" FOREIGN KEY ("membership_snapshot_id","user_id") REFERENCES "public"."access_membership_members"("snapshot_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_opt_out_records" ADD CONSTRAINT "sms_opt_out_records_endpoint_fk" FOREIGN KEY ("roster_snapshot_id","recipient_id","endpoint_id","population","channel") REFERENCES "public"."roster_endpoints"("roster_snapshot_id","recipient_id","id","population","channel") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_facility_scopes" ADD CONSTRAINT "user_facility_scopes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_facility_scopes" ADD CONSTRAINT "user_facility_scopes_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_api_keys_prefix_uq" ON "agent_api_keys" USING btree ("key_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_api_keys_digest_uq" ON "agent_api_keys" USING btree ("credential_digest");--> statement-breakpoint
CREATE INDEX "agent_api_keys_agent_idx" ON "agent_api_keys" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "audience_configurations_facility_idx" ON "audience_configurations" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "channel_attempts_intent_idx" ON "channel_attempts" USING btree ("intent_id");--> statement-breakpoint
CREATE INDEX "connectivity_epochs_session_idx" ON "connectivity_epochs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "delivery_evidence_subject_idx" ON "delivery_evidence" USING btree ("subject_kind","intent_id","attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_enrollments_installation_uq" ON "device_enrollments" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "device_enrollments_user_idx" ON "device_enrollments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "device_push_token_registrations_device_idx" ON "device_push_token_registrations" USING btree ("device_enrollment_id","registered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "event_transitions_request_uq" ON "event_transitions" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_transitions_idempotency_uq" ON "event_transitions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "event_type_versions_enabled_idx" ON "event_type_versions" USING btree ("template_mode","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "event_types_key_uq" ON "event_types" USING btree ("key");--> statement-breakpoint
CREATE INDEX "event_types_family_idx" ON "event_types" USING btree ("family_key");--> statement-breakpoint
CREATE INDEX "events_active_facility_idx" ON "events" USING btree ("facility_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "facilities_code_uq" ON "facilities" USING btree ("code");--> statement-breakpoint
CREATE INDEX "group_sources_facility_idx" ON "group_sources" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "integration_statuses_latest_idx" ON "integration_statuses" USING btree ("integration_id","observed_at");--> statement-breakpoint
CREATE INDEX "journal_entries_event_time_idx" ON "journal_entries" USING btree ("event_id","server_time");--> statement-breakpoint
CREATE UNIQUE INDEX "media_records_storage_key_uq" ON "media_records" USING btree ("storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "media_upload_intents_storage_key_uq" ON "media_upload_intents" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "neighborhood_facilities_facility_idx" ON "neighborhood_facilities" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_intents_request_uq" ON "notification_intents" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "outbox_claim_idx" ON "outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "roster_endpoints_recipient_idx" ON "roster_endpoints" USING btree ("roster_snapshot_id","recipient_id");--> statement-breakpoint
CREATE INDEX "roster_snapshot_facilities_facility_idx" ON "roster_snapshot_facilities" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "security_audit_entries_sequence_uq" ON "security_audit_entries" USING btree ("sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "security_audit_entries_hash_uq" ON "security_audit_entries" USING btree ("entry_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "security_audit_entries_request_uq" ON "security_audit_entries" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "security_audit_entries_query_idx" ON "security_audit_entries" USING btree ("occurred_at","category","outcome");--> statement-breakpoint
CREATE INDEX "session_revocations_session_idx" ON "session_revocations" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_token_replays_session_idx" ON "session_token_replays" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_token_rotations_session_idx" ON "session_token_rotations" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_device_idx" ON "sessions" USING btree ("device_enrollment_id");--> statement-breakpoint
CREATE INDEX "user_facility_scopes_facility_idx" ON "user_facility_scopes" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_google_subject_uq" ON "users" USING btree ("google_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint

-- Retention and append-only truth are database boundaries, not application conventions.
CREATE OR REPLACE FUNCTION "psd_eoc_reject_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'PSD EOC records are retained; DELETE is not permitted on %', TG_TABLE_NAME
		USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "psd_eoc_reject_immutable_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'PSD EOC immutable truth cannot be changed on %', TG_TABLE_NAME
		USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "psd_eoc_guard_event_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF (
		to_jsonb(NEW) - ARRAY[
			'status', 'roster_snapshot_id', 'roster_population', 'activated_at',
			'all_clear_at', 'reactivated_at', 'closed_at', 'activation_authorization'
		]::text[]
	) IS DISTINCT FROM (
		to_jsonb(OLD) - ARRAY[
			'status', 'roster_snapshot_id', 'roster_population', 'activated_at',
			'all_clear_at', 'reactivated_at', 'closed_at', 'activation_authorization'
		]::text[]
	) THEN
		RAISE EXCEPTION 'Event identity and real/drill classification are immutable'
			USING ERRCODE = '55000';
	END IF;

	IF OLD.roster_snapshot_id IS NOT NULL AND (
		NEW.roster_snapshot_id IS DISTINCT FROM OLD.roster_snapshot_id
		OR NEW.roster_population IS DISTINCT FROM OLD.roster_population
	) THEN
		RAISE EXCEPTION 'An activated event cannot change its pinned roster'
			USING ERRCODE = '55000';
	END IF;

	IF (OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at)
		OR (OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at)
		OR (
			OLD.activation_authorization IS NOT NULL
			AND NEW.activation_authorization IS DISTINCT FROM OLD.activation_authorization
		)
	THEN
		RAISE EXCEPTION 'Event activation, close time, and activation provenance are write-once'
			USING ERRCODE = '55000';
	END IF;

	IF NOT (
		(
			OLD.status = 'draft'
			AND NEW.status = 'active'
			AND NEW.activated_at >= NEW.created_at
			AND NEW.all_clear_at IS NULL
			AND NEW.reactivated_at IS NULL
			AND NEW.closed_at IS NULL
		)
		OR (
			OLD.status = 'active'
			AND NEW.status = 'all-clear'
			AND NEW.all_clear_at IS NOT NULL
			AND (OLD.all_clear_at IS NULL OR NEW.all_clear_at > OLD.all_clear_at)
			AND NEW.all_clear_at >= COALESCE(OLD.reactivated_at, OLD.activated_at)
			AND NEW.reactivated_at IS NOT DISTINCT FROM OLD.reactivated_at
			AND NEW.closed_at IS NOT DISTINCT FROM OLD.closed_at
		)
		OR (
			OLD.status = 'all-clear'
			AND NEW.status = 'active'
			AND NEW.all_clear_at IS NOT DISTINCT FROM OLD.all_clear_at
			AND NEW.reactivated_at IS NOT NULL
			AND (OLD.reactivated_at IS NULL OR NEW.reactivated_at > OLD.reactivated_at)
			AND NEW.reactivated_at >= OLD.all_clear_at
			AND NEW.closed_at IS NOT DISTINCT FROM OLD.closed_at
		)
		OR (
			OLD.status = 'all-clear'
			AND NEW.status = 'closed'
			AND NEW.all_clear_at IS NOT DISTINCT FROM OLD.all_clear_at
			AND NEW.reactivated_at IS NOT DISTINCT FROM OLD.reactivated_at
			AND NEW.closed_at IS NOT NULL
			AND NEW.closed_at >= OLD.all_clear_at
		)
	) THEN
		RAISE EXCEPTION 'Event lifecycle updates must follow the allowed state machine'
			USING ERRCODE = '55000';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "psd_eoc_guard_draft_classification"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF to_jsonb(NEW) -> 'event_type_id' IS DISTINCT FROM to_jsonb(OLD) -> 'event_type_id'
		OR to_jsonb(NEW) -> 'template_mode' IS DISTINCT FROM to_jsonb(OLD) -> 'template_mode'
		OR to_jsonb(NEW) -> 'classification_marker' IS DISTINCT FROM to_jsonb(OLD) -> 'classification_marker'
	THEN
		RAISE EXCEPTION 'Event-type draft classification cannot change in place'
			USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "psd_eoc_guard_outbox_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF (
		to_jsonb(NEW) - ARRAY[
			'status', 'attempts', 'available_at', 'locked_until',
			'published_at', 'failed_at', 'last_error_code'
		]::text[]
	) IS DISTINCT FROM (
		to_jsonb(OLD) - ARRAY[
			'status', 'attempts', 'available_at', 'locked_until',
			'published_at', 'failed_at', 'last_error_code'
		]::text[]
	) THEN
		RAISE EXCEPTION 'Outbox message content and classification are immutable'
			USING ERRCODE = '55000';
	END IF;

	IF NOT (
		(
			OLD.status = 'pending'
			AND NEW.status = 'processing'
			AND NEW.attempts = OLD.attempts + 1
			AND NEW.available_at IS NOT DISTINCT FROM OLD.available_at
			AND NEW.locked_until IS NOT NULL
			AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at
			AND NEW.failed_at IS NOT DISTINCT FROM OLD.failed_at
			AND NEW.last_error_code IS NOT DISTINCT FROM OLD.last_error_code
		)
		OR (
			OLD.status = 'processing'
			AND NEW.status = 'processing'
			AND NEW.available_at IS NOT DISTINCT FROM OLD.available_at
			AND NEW.locked_until > OLD.locked_until
			AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at
			AND NEW.failed_at IS NOT DISTINCT FROM OLD.failed_at
			AND NEW.last_error_code IS NOT DISTINCT FROM OLD.last_error_code
			AND NEW.attempts IN (OLD.attempts, OLD.attempts + 1)
		)
		OR (
			OLD.status = 'processing'
			AND NEW.status = 'pending'
			AND NEW.attempts = OLD.attempts
			AND NEW.available_at >= OLD.available_at
			AND NEW.locked_until IS NULL
			AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at
			AND NEW.failed_at IS NOT DISTINCT FROM OLD.failed_at
			AND NEW.last_error_code IS NOT DISTINCT FROM OLD.last_error_code
		)
		OR (
			OLD.status = 'processing'
			AND NEW.status = 'published'
			AND NEW.attempts = OLD.attempts
			AND NEW.available_at IS NOT DISTINCT FROM OLD.available_at
			AND NEW.locked_until IS NULL
			AND NEW.published_at IS NOT NULL
			AND NEW.failed_at IS NOT DISTINCT FROM OLD.failed_at
			AND NEW.last_error_code IS NOT DISTINCT FROM OLD.last_error_code
		)
		OR (
			OLD.status = 'processing'
			AND NEW.status = 'failed'
			AND NEW.attempts = OLD.attempts
			AND NEW.available_at IS NOT DISTINCT FROM OLD.available_at
			AND NEW.locked_until IS NULL
			AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at
			AND NEW.failed_at IS NOT NULL
			AND NEW.last_error_code IS NOT NULL
		)
	) THEN
		RAISE EXCEPTION 'Outbox state, lease, and attempt transitions must be monotonic'
			USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "psd_eoc_guard_idempotency_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF (
		to_jsonb(NEW) - ARRAY['status', 'completed_at', 'result_reference']::text[]
	) IS DISTINCT FROM (
		to_jsonb(OLD) - ARRAY['status', 'completed_at', 'result_reference']::text[]
	) THEN
		RAISE EXCEPTION 'Idempotency scope, key, principal, and request digest are immutable'
			USING ERRCODE = '55000';
	END IF;
	IF OLD.status <> 'in-progress' OR NEW.status NOT IN ('completed', 'failed') THEN
		RAISE EXCEPTION 'Idempotency records may transition exactly once from in-progress to terminal'
			USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "psd_eoc_guard_confirmation_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF (
		to_jsonb(NEW) - ARRAY[
			'status', 'consumed_at', 'consumed_for_request_id', 'expired_at'
		]::text[]
	) IS DISTINCT FROM (
		to_jsonb(OLD) - ARRAY[
			'status', 'consumed_at', 'consumed_for_request_id', 'expired_at'
		]::text[]
	) THEN
		RAISE EXCEPTION 'Human confirmation identity, scope, and consequence digest are immutable'
			USING ERRCODE = '55000';
	END IF;
	IF OLD.status <> 'issued' OR NEW.status NOT IN ('consumed', 'expired') THEN
		RAISE EXCEPTION 'Human confirmations may transition exactly once from issued to terminal'
			USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

DO $$
DECLARE
	table_name text;
BEGIN
	FOR table_name IN
		SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public'
	LOOP
		EXECUTE format(
			'CREATE TRIGGER %I BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION psd_eoc_reject_delete()',
			table_name || '_retain_guard', table_name
		);
	END LOOP;
END;
$$;--> statement-breakpoint

DO $$
DECLARE
	table_name text;
BEGIN
	FOREACH table_name IN ARRAY ARRAY[
		'roster_snapshots',
		'roster_sync_results',
		'roster_recipients',
		'roster_endpoints',
		'event_types',
		'event_type_versions',
		'event_type_templates',
		'integration_statuses',
		'activation_previews',
		'prepared_activations',
		'lifecycle_consequence_previews',
		'event_transitions',
		'prepared_activation_consumptions',
		'journal_entries',
		'notification_intents',
		'notification_intent_channels',
		'dispatch_batches',
		'channel_attempts',
		'delivery_evidence',
		'endpoint_status_records',
		'sms_opt_out_records',
		'security_audit_entries'
	]
	LOOP
		EXECUTE format(
			'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION psd_eoc_reject_immutable_mutation()',
			table_name || '_immutable_guard', table_name
		);
	END LOOP;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "events_identity_guard"
BEFORE UPDATE ON "events"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_guard_event_mutation"();--> statement-breakpoint
CREATE TRIGGER "event_type_version_drafts_classification_guard"
BEFORE UPDATE ON "event_type_version_drafts"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_guard_draft_classification"();--> statement-breakpoint
CREATE TRIGGER "event_type_draft_templates_classification_guard"
BEFORE UPDATE ON "event_type_draft_templates"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_guard_draft_classification"();--> statement-breakpoint
CREATE TRIGGER "outbox_payload_guard"
BEFORE UPDATE ON "outbox"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_guard_outbox_mutation"();--> statement-breakpoint
CREATE TRIGGER "idempotency_records_scope_guard"
BEFORE UPDATE ON "idempotency_records"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_guard_idempotency_mutation"();--> statement-breakpoint
CREATE TRIGGER "human_confirmation_records_scope_guard"
BEFORE UPDATE ON "human_confirmation_records"
FOR EACH ROW EXECUTE FUNCTION "psd_eoc_guard_confirmation_mutation"();--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'psd_eoc_app') THEN
		CREATE ROLE "psd_eoc_app" NOLOGIN;
	END IF;
END;
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA "public" TO "psd_eoc_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "public" TO "psd_eoc_app";--> statement-breakpoint
REVOKE DELETE ON ALL TABLES IN SCHEMA "public" FROM "psd_eoc_app";--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE
	"journal_entries",
	"channel_attempts",
	"delivery_evidence"
FROM "psd_eoc_app";
