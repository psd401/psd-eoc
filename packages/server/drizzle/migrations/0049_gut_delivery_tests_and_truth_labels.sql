-- Deletes the monthly live delivery-test system and the integration truth
-- labels, leaving one enabled flag per notification channel.
--
-- Why. A staff drill on 2026-09-07 delivered push and email while SMS never
-- reached the provider. The chain was: the carrier registration had been
-- approved for hours, but aws-eum-sms still carried the hand-maintained label
-- 'blocked'; the admin page refused to enable a blocked channel; a database
-- CHECK refused the same; and after the row was edited by hand the worker
-- still refused because the batch's copy of the label record had to match the
-- current row field for field, in ten separate places, with nothing logged
-- about which field disagreed. None of that state had an automated source.
-- The delivery-test system was a second, parallel send path (canary target
-- sets, eligibility facts, runs, reports, a monthly reminder alarm, and a
-- product-owner authorization artifact) that had never run in production.
--
-- What changes. The seven delivery-test and integration-status tables go,
-- with the columns, foreign keys, and CHECK constraints on activation
-- previews, notification intents, intent channels, dispatch batches, and the
-- outbox that referenced them. channel_configurations keeps integration_id,
-- enabled, and changed_at. Two enum types go with their tables.
--
-- Historical JSON. Outbox messages and consequence previews are JSON copies
-- of the contracts, which are strict; every stored copy carries the retired
-- 'deliveryTest' key and an 'integrationStatus' object per channel. Each is
-- rewritten to the current shape -- 'integrationId' replaces the status
-- object, 'deliveryTest' is removed -- so the workers can still read them and
-- so the replacement outbox plan CHECK validates against every row. The
-- outbox payload guard comes off for the counted rewrite and goes back on,
-- exactly as 0030 did.
--
-- Enum values. mutation_capability and agent_capability_grant keep the values
-- the catalog no longer offers: PostgreSQL cannot drop a value from an enum
-- type, and idempotency and grant rows written under them remain valid. The
-- schema declares them as retired.
DROP TRIGGER IF EXISTS "activation_previews_delivery_test_binding_guard" ON "activation_previews";--> statement-breakpoint
DROP TRIGGER IF EXISTS "notification_intents_delivery_test_binding_guard" ON "notification_intents";--> statement-breakpoint
DROP TRIGGER IF EXISTS "channel_attempts_delivery_test_target_guard" ON "channel_attempts";--> statement-breakpoint
DROP TRIGGER IF EXISTS "prepared_activations_delivery_test_guard" ON "prepared_activations";--> statement-breakpoint
ALTER TABLE "delivery_test_canary_eligibility_facts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "delivery_test_target_endpoints" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "delivery_test_target_set_versions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_channel_change_authorizations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_statuses" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "delivery_test_reports" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "delivery_test_runs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "delivery_test_canary_eligibility_facts" CASCADE;--> statement-breakpoint
DROP TABLE "delivery_test_target_endpoints" CASCADE;--> statement-breakpoint
DROP TABLE "delivery_test_target_set_versions" CASCADE;--> statement-breakpoint
DROP TABLE "integration_channel_change_authorizations" CASCADE;--> statement-breakpoint
DROP TABLE "integration_statuses" CASCADE;--> statement-breakpoint
DROP TABLE "delivery_test_reports" CASCADE;--> statement-breakpoint
DROP TABLE "delivery_test_runs" CASCADE;--> statement-breakpoint
ALTER TABLE "activation_previews" DROP CONSTRAINT "activation_previews_delivery_test_anchor_uq";--> statement-breakpoint
ALTER TABLE "notification_intents" DROP CONSTRAINT "notification_intents_delivery_test_anchor_uq";--> statement-breakpoint
ALTER TABLE "channel_configurations" DROP CONSTRAINT IF EXISTS "channel_configurations_blocked_disabled";--> statement-breakpoint
ALTER TABLE "activation_previews" DROP CONSTRAINT "activation_previews_delivery_test_truth";--> statement-breakpoint
ALTER TABLE "activation_previews" DROP CONSTRAINT "activation_previews_delivery_test_digest_format";--> statement-breakpoint
ALTER TABLE "dispatch_batches" DROP CONSTRAINT "dispatch_batches_integration_population";--> statement-breakpoint
ALTER TABLE "notification_intent_channels" DROP CONSTRAINT "notification_intent_channels_integration_population";--> statement-breakpoint
ALTER TABLE "notification_intents" DROP CONSTRAINT "notification_intents_delivery_test_truth";--> statement-breakpoint
ALTER TABLE "notification_intents" DROP CONSTRAINT "notification_intents_delivery_test_digest_format";--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_channel_plan_integration_truth";--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_channel_plan_shape";--> statement-breakpoint
ALTER TABLE "channel_configurations" DROP CONSTRAINT IF EXISTS "channel_configurations_status_truth_fk";
--> statement-breakpoint
ALTER TABLE "activation_previews" DROP CONSTRAINT IF EXISTS "activation_previews_delivery_test_target_set_fk";
--> statement-breakpoint
ALTER TABLE "dispatch_batches" DROP CONSTRAINT IF EXISTS "dispatch_batches_integration_truth_fk";
--> statement-breakpoint
ALTER TABLE "notification_intent_channels" DROP CONSTRAINT IF EXISTS "notification_intent_channels_integration_truth_fk";
--> statement-breakpoint
ALTER TABLE "notification_intents" DROP CONSTRAINT IF EXISTS "notification_intents_delivery_test_target_set_fk";
--> statement-breakpoint
ALTER TABLE "channel_configurations" DROP COLUMN "status_id";--> statement-breakpoint
ALTER TABLE "channel_configurations" DROP COLUMN "status_label";--> statement-breakpoint
ALTER TABLE "activation_previews" DROP COLUMN "delivery_test_target_set_id";--> statement-breakpoint
ALTER TABLE "activation_previews" DROP COLUMN "delivery_test_target_set_version";--> statement-breakpoint
ALTER TABLE "activation_previews" DROP COLUMN "delivery_test_endpoint_reference_digest";--> statement-breakpoint
ALTER TABLE "dispatch_batches" DROP COLUMN "integration_status_id";--> statement-breakpoint
ALTER TABLE "dispatch_batches" DROP COLUMN "integration_label";--> statement-breakpoint
ALTER TABLE "notification_intent_channels" DROP COLUMN "integration_status_id";--> statement-breakpoint
ALTER TABLE "notification_intent_channels" DROP COLUMN "integration_label";--> statement-breakpoint
ALTER TABLE "notification_intents" DROP COLUMN "delivery_test_target_set_id";--> statement-breakpoint
ALTER TABLE "notification_intents" DROP COLUMN "delivery_test_target_set_version";--> statement-breakpoint
ALTER TABLE "notification_intents" DROP COLUMN "delivery_test_endpoint_reference_digest";--> statement-breakpoint
-- Rewrite every stored channel plan to the current contract shape before the
-- replacement outbox CHECK is added and before any worker reads a queued row.
DO $$
DECLARE
	guard_count integer;
	stale_before integer;
	stale_after integer;
	rewritten integer;
	digest_before text;
	digest_after text;
BEGIN
	SELECT count(*)::integer INTO guard_count
	FROM pg_catalog.pg_trigger AS trigger
	JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
	JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
	WHERE namespace.nspname = 'public'
		AND relation.relname = 'outbox'
		AND trigger.tgname = 'outbox_payload_guard'
		AND trigger.tgenabled = 'O'
		AND trigger.tgfoid = 'public.psd_eoc_guard_outbox_mutation()'::pg_catalog.regprocedure
		AND NOT trigger.tgisinternal;
	IF guard_count <> 1 THEN
		RAISE EXCEPTION 'Outbox payload guard is absent or disabled'
			USING ERRCODE = '55000';
	END IF;

	SELECT count(*)::integer INTO stale_before
	FROM public."outbox"
	WHERE "message" ? 'deliveryTest'
		OR jsonb_path_exists("message", '$.channels[*].integrationStatus');

	-- Everything except the rewritten message must survive byte for byte.
	SELECT pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(
			(to_jsonb(outbox_row) - 'message') ORDER BY outbox_row."id")::text, 'null'))
	INTO digest_before FROM public."outbox" AS outbox_row;

	DROP TRIGGER outbox_payload_guard ON public."outbox";

	UPDATE public."outbox"
	SET "message" = ("message" - 'deliveryTest') || jsonb_build_object(
		'channels',
		(
			SELECT coalesce(jsonb_agg(
				CASE
					WHEN channel ? 'integrationStatus' THEN
						(channel - 'integrationStatus')
							|| jsonb_build_object('integrationId', channel -> 'integrationStatus' -> 'integrationId')
					ELSE channel
				END
				ORDER BY ordinality
			), '[]'::jsonb)
			FROM jsonb_array_elements("message" -> 'channels') WITH ORDINALITY AS plan(channel, ordinality)
		)
	)
	WHERE "message" ? 'deliveryTest'
		OR jsonb_path_exists("message", '$.channels[*].integrationStatus');
	GET DIAGNOSTICS rewritten = ROW_COUNT;

	CREATE TRIGGER outbox_payload_guard BEFORE UPDATE ON public."outbox"
		FOR EACH ROW EXECUTE FUNCTION public.psd_eoc_guard_outbox_mutation();

	SELECT count(*)::integer INTO guard_count
	FROM pg_catalog.pg_trigger AS trigger
	JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
	JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
	WHERE namespace.nspname = 'public'
		AND relation.relname = 'outbox'
		AND trigger.tgname = 'outbox_payload_guard'
		AND trigger.tgenabled = 'O'
		AND trigger.tgfoid = 'public.psd_eoc_guard_outbox_mutation()'::pg_catalog.regprocedure
		AND NOT trigger.tgisinternal;
	IF guard_count <> 1 THEN
		RAISE EXCEPTION 'Outbox payload guard was not restored exactly'
			USING ERRCODE = '55000';
	END IF;

	IF rewritten <> stale_before THEN
		RAISE EXCEPTION 'Outbox rewrite touched % row(s) instead of %', rewritten, stale_before
			USING ERRCODE = '55000';
	END IF;

	SELECT count(*)::integer INTO stale_after
	FROM public."outbox"
	WHERE "message" ? 'deliveryTest'
		OR jsonb_path_exists("message", '$.channels[*].integrationStatus');
	IF stale_after <> 0 THEN
		RAISE EXCEPTION '% outbox message(s) still carry retired keys', stale_after
			USING ERRCODE = '55000';
	END IF;

	SELECT pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(
			(to_jsonb(outbox_row) - 'message') ORDER BY outbox_row."id")::text, 'null'))
	INTO digest_after FROM public."outbox" AS outbox_row;
	IF digest_after IS DISTINCT FROM digest_before THEN
		RAISE EXCEPTION 'Outbox rows changed beyond the message rewrite'
			USING ERRCODE = '55000';
	END IF;

	RAISE NOTICE 'Rewrote % outbox message(s) to the current channel plan shape', rewritten;
END;
$$;--> statement-breakpoint
UPDATE "activation_previews"
SET "channels" = (
	SELECT coalesce(jsonb_agg(
		CASE
			WHEN channel ? 'integrationStatus' THEN
				(channel - 'integrationStatus')
					|| jsonb_build_object('integrationId', channel -> 'integrationStatus' -> 'integrationId')
			ELSE channel
		END
		ORDER BY ordinality
	), '[]'::jsonb)
	FROM jsonb_array_elements("channels") WITH ORDINALITY AS plan(channel, ordinality)
)
WHERE jsonb_path_exists("channels", '$[*].integrationStatus');--> statement-breakpoint
UPDATE "lifecycle_consequence_previews"
SET "channels" = (
	SELECT coalesce(jsonb_agg(
		CASE
			WHEN channel ? 'integrationStatus' THEN
				(channel - 'integrationStatus')
					|| jsonb_build_object('integrationId', channel -> 'integrationStatus' -> 'integrationId')
			ELSE channel
		END
		ORDER BY ordinality
	), '[]'::jsonb)
	FROM jsonb_array_elements("channels") WITH ORDINALITY AS plan(channel, ordinality)
)
WHERE jsonb_path_exists("channels", '$[*].integrationStatus');--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_channel_plan_shape" CHECK (case
        when jsonb_typeof("outbox"."channels") = 'array' then
          jsonb_array_length("outbox"."channels") between 2 and 3
          and jsonb_array_length(jsonb_path_query_array(
            "outbox"."channels", '$[*] ? (@.channel == "push" && @.renderedMessage.channel == "push" && (@.integrationId == "expo-push" || @.integrationId == "mobile-push"))'
          )) = 1
          and jsonb_array_length(jsonb_path_query_array(
            "outbox"."channels", '$[*] ? (@.channel == "email" && @.renderedMessage.channel == "email" && @.integrationId == "ses-email")'
          )) = 1
          and jsonb_array_length(jsonb_path_query_array(
            "outbox"."channels", '$[*] ? (@.channel == "sms" && @.renderedMessage.channel == "sms" && @.integrationId == "aws-eum-sms")'
          )) <= 1
          and jsonb_array_length(jsonb_path_query_array(
            "outbox"."channels", '$[*] ? (@.channel == "push" || @.channel == "email" || @.channel == "sms")'
          )) = jsonb_array_length("outbox"."channels")
        else false
      end);--> statement-breakpoint
DROP TYPE "public"."delivery_test_report_status";--> statement-breakpoint
DROP TYPE "public"."integration_truth_label";--> statement-breakpoint
DROP FUNCTION IF EXISTS public."psd_eoc_guard_delivery_test_binding_insert"();--> statement-breakpoint
DROP FUNCTION IF EXISTS public."psd_eoc_guard_delivery_test_attempt_insert"();--> statement-breakpoint
DROP FUNCTION IF EXISTS public."psd_eoc_reject_prepared_delivery_test"();--> statement-breakpoint
DROP FUNCTION IF EXISTS public."psd_eoc_guard_delivery_test_canary_eligibility_insert"();--> statement-breakpoint
DROP FUNCTION IF EXISTS public."psd_eoc_guard_delivery_test_report_insert"();--> statement-breakpoint
DROP FUNCTION IF EXISTS public."psd_eoc_guard_delivery_test_target_endpoint_insert"();--> statement-breakpoint
DROP FUNCTION IF EXISTS public."psd_eoc_guard_delivery_test_target_set_insert"();--> statement-breakpoint
DROP FUNCTION IF EXISTS public."psd_eoc_validate_delivery_test_target_set"();--> statement-breakpoint
DROP FUNCTION IF EXISTS public."psd_eoc_guard_integration_status_insert"();--> statement-breakpoint
DROP FUNCTION IF EXISTS public."psd_eoc_sync_channel_configuration_after_status"();
