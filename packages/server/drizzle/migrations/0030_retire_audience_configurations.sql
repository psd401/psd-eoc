-- Retires the audience configuration layer.
--
-- An audience configuration was a versioned, administrator-authored policy
-- naming who an activation reaches: the event's own building, optionally a
-- neighborhood, optionally district-level "others" groups. Every notification
-- record pinned the exact version it resolved, so history stayed
-- reconstructable across policy edits.
--
-- It carried no information. The live export taken for issue #292 read all
-- twenty production configurations: every one held a single `building` target
-- pointing at its own facility, and no deployment ever configured a
-- neighborhood or an others target. The rule the district actually operates is
-- the one sentence the table spent two tables, seven pinned column pairs and
-- three capabilities encoding — an event at a school reaches that school's
-- staff — and `resolveAudience` now says exactly that, from the facility.
--
-- What goes: `audience_configurations` and `audience_targets`, the
-- `audience_config_id` / `audience_config_version` pair from the seven tables
-- that pinned it, the `audience_target_kind` type, and
-- `create-audience-config-version` / `get-audience-config` /
-- `get-audience-config-version` from the two capability enums.
--
-- What stays: neighborhoods. They are a district concept in their own right,
-- `resolveEventRecipients` reads `neighborhood_facilities` directly for an
-- event that reaches past its own building, and the admin surface still
-- versions them. Only the audience layer's pin on them goes.
--
-- The composite "truth" foreign keys and anchor unique constraints named the
-- pair among their columns. Dropping a column would drop those constraints
-- whole, so each is dropped and recreated explicitly, minus the two columns.
-- Every other column in each stays in its original order, so what a dispatch
-- batch must still prove about its outbox row is unchanged.
--
-- Tables are locked first, NOWAIT: this takes ACCESS EXCLUSIVE on all of them
-- regardless, and a migration that cannot have them to itself should fail
-- immediately rather than queue behind live traffic.
LOCK TABLE
	public."audience_configurations",
	public."audience_targets",
	public."activation_previews",
	public."prepared_activations",
	public."prepared_activation_consumptions",
	public."lifecycle_consequence_previews",
	public."notification_intents",
	public."outbox",
	public."dispatch_batches"
IN ACCESS EXCLUSIVE MODE NOWAIT;--> statement-breakpoint
ALTER TABLE "activation_previews" DROP CONSTRAINT "activation_previews_audience_fk";--> statement-breakpoint
ALTER TABLE "dispatch_batches" DROP CONSTRAINT "dispatch_batches_audience_fk";--> statement-breakpoint
ALTER TABLE "dispatch_batches" DROP CONSTRAINT "dispatch_batches_notification_intent_truth_fk";--> statement-breakpoint
ALTER TABLE "dispatch_batches" DROP CONSTRAINT "dispatch_batches_outbox_truth_fk";--> statement-breakpoint
ALTER TABLE "lifecycle_consequence_previews" DROP CONSTRAINT "lifecycle_consequence_previews_audience_fk";--> statement-breakpoint
ALTER TABLE "notification_intents" DROP CONSTRAINT "notification_intents_audience_fk";--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_audience_fk";--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_notification_intent_truth_fk";--> statement-breakpoint
ALTER TABLE "prepared_activation_consumptions" DROP CONSTRAINT "prepared_activation_consumptions_preparation_truth_fk";--> statement-breakpoint
ALTER TABLE "prepared_activations" DROP CONSTRAINT "prepared_activations_preview_truth_fk";--> statement-breakpoint
ALTER TABLE "activation_previews" DROP CONSTRAINT "activation_previews_preparation_anchor_uq";--> statement-breakpoint
ALTER TABLE "notification_intents" DROP CONSTRAINT "notification_intents_worker_anchor_uq";--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_worker_anchor_uq";--> statement-breakpoint
ALTER TABLE "prepared_activations" DROP CONSTRAINT "prepared_activations_consumption_anchor_uq";--> statement-breakpoint
ALTER TABLE "outbox" DROP CONSTRAINT "outbox_message_truth";--> statement-breakpoint
-- An outbox message is a JSON copy of what it carries, and `outbox_message_truth`
-- asserted its `audienceConfig` matched the columns. The columns go, so the key
-- has to go with them: `OutboxMessageSchema` is strict, and a worker reading a
-- message with a key the contract no longer declares would refuse the whole
-- message rather than ignore the extra field.
--
-- `outbox_payload_guard` refuses any update that touches message content, which
-- is the rule and stays the rule. It comes off for a bounded, counted rewrite
-- and goes back on, the way 0025 suspended the retain guards, and the count is
-- announced: a deployment with no queued work rewrites nothing and every
-- assertion below still holds.
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
	FROM public."outbox" WHERE "message" ? 'audienceConfig';

	-- Everything except the retired key must survive byte for byte.
	SELECT pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(
			(to_jsonb(outbox_row) - 'message') || jsonb_build_object('message', outbox_row."message" - 'audienceConfig')
			ORDER BY outbox_row."id")::text, 'null'))
	INTO digest_before FROM public."outbox" AS outbox_row;

	DROP TRIGGER outbox_payload_guard ON public."outbox";

	UPDATE public."outbox"
	SET "message" = "message" - 'audienceConfig'
	WHERE "message" ? 'audienceConfig';
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
	FROM public."outbox" WHERE "message" ? 'audienceConfig';
	IF stale_after <> 0 THEN
		RAISE EXCEPTION '% outbox message(s) still carry audienceConfig', stale_after
			USING ERRCODE = '55000';
	END IF;

	SELECT pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(to_jsonb(outbox_row) ORDER BY outbox_row."id")::text, 'null'))
	INTO digest_after FROM public."outbox" AS outbox_row;
	IF digest_after IS DISTINCT FROM digest_before THEN
		RAISE EXCEPTION 'Outbox rows changed beyond removing audienceConfig'
			USING ERRCODE = '55000';
	END IF;

	RAISE NOTICE 'Removed audienceConfig from % outbox message(s)', rewritten;
END;
$$;--> statement-breakpoint
ALTER TABLE "activation_previews" DROP COLUMN "audience_config_id";--> statement-breakpoint
ALTER TABLE "activation_previews" DROP COLUMN "audience_config_version";--> statement-breakpoint
ALTER TABLE "dispatch_batches" DROP COLUMN "audience_config_id";--> statement-breakpoint
ALTER TABLE "dispatch_batches" DROP COLUMN "audience_config_version";--> statement-breakpoint
ALTER TABLE "lifecycle_consequence_previews" DROP COLUMN "audience_config_id";--> statement-breakpoint
ALTER TABLE "lifecycle_consequence_previews" DROP COLUMN "audience_config_version";--> statement-breakpoint
ALTER TABLE "notification_intents" DROP COLUMN "audience_config_id";--> statement-breakpoint
ALTER TABLE "notification_intents" DROP COLUMN "audience_config_version";--> statement-breakpoint
ALTER TABLE "outbox" DROP COLUMN "audience_config_id";--> statement-breakpoint
ALTER TABLE "outbox" DROP COLUMN "audience_config_version";--> statement-breakpoint
ALTER TABLE "prepared_activation_consumptions" DROP COLUMN "audience_config_id";--> statement-breakpoint
ALTER TABLE "prepared_activation_consumptions" DROP COLUMN "audience_config_version";--> statement-breakpoint
ALTER TABLE "prepared_activations" DROP COLUMN "audience_config_id";--> statement-breakpoint
ALTER TABLE "prepared_activations" DROP COLUMN "audience_config_version";--> statement-breakpoint
ALTER TABLE "activation_previews" ADD CONSTRAINT "activation_previews_preparation_anchor_uq" UNIQUE("id","facility_id","kind","template_mode","event_type_version_id","roster_snapshot_id","roster_population","consequence_digest");--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_worker_anchor_uq" UNIQUE("id","event_id","event_kind","template_mode","purpose","event_type_version_id","roster_snapshot_id","roster_population","request_id","authorization");--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_worker_anchor_uq" UNIQUE("id","intent_id","event_id","event_kind","template_mode","purpose","event_type_version_id","roster_snapshot_id","roster_population","request_id","authorization");--> statement-breakpoint
ALTER TABLE "prepared_activations" ADD CONSTRAINT "prepared_activations_consumption_anchor_uq" UNIQUE("id","facility_id","kind","template_mode","event_type_version_id","roster_snapshot_id","roster_population","consequence_digest");--> statement-breakpoint
ALTER TABLE "dispatch_batches" ADD CONSTRAINT "dispatch_batches_notification_intent_truth_fk" FOREIGN KEY ("intent_id","event_id","event_kind","template_mode","purpose","event_type_version_id","roster_snapshot_id","roster_population","request_id","authorization") REFERENCES "public"."notification_intents"("id","event_id","event_kind","template_mode","purpose","event_type_version_id","roster_snapshot_id","roster_population","request_id","authorization") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_batches" ADD CONSTRAINT "dispatch_batches_outbox_truth_fk" FOREIGN KEY ("outbox_id","intent_id","event_id","event_kind","template_mode","purpose","event_type_version_id","roster_snapshot_id","roster_population","request_id","authorization") REFERENCES "public"."outbox"("id","intent_id","event_id","event_kind","template_mode","purpose","event_type_version_id","roster_snapshot_id","roster_population","request_id","authorization") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_notification_intent_truth_fk" FOREIGN KEY ("intent_id","event_id","event_kind","template_mode","purpose","event_type_version_id","roster_snapshot_id","roster_population","request_id","authorization") REFERENCES "public"."notification_intents"("id","event_id","event_kind","template_mode","purpose","event_type_version_id","roster_snapshot_id","roster_population","request_id","authorization") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepared_activation_consumptions" ADD CONSTRAINT "prepared_activation_consumptions_preparation_truth_fk" FOREIGN KEY ("prepared_activation_id","facility_id","kind","template_mode","event_type_version_id","roster_snapshot_id","roster_population","consequence_digest") REFERENCES "public"."prepared_activations"("id","facility_id","kind","template_mode","event_type_version_id","roster_snapshot_id","roster_population","consequence_digest") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepared_activations" ADD CONSTRAINT "prepared_activations_preview_truth_fk" FOREIGN KEY ("activation_preview_id","facility_id","kind","template_mode","event_type_version_id","roster_snapshot_id","roster_population","consequence_digest") REFERENCES "public"."activation_previews"("id","facility_id","kind","template_mode","event_type_version_id","roster_snapshot_id","roster_population","consequence_digest") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_message_truth" CHECK (jsonb_typeof("outbox"."message") is not distinct from 'object'
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
        and "outbox"."message" ->> 'requestId' is not distinct from "outbox"."request_id"::text
        and ("outbox"."message" ->> 'version')::integer is not distinct from "outbox"."message_version"
        and (
          (
            "outbox"."message_version" = 1
            and not ("outbox"."message" ? 'facilityId')
          ) or (
            "outbox"."message_version" = 2
            and jsonb_typeof("outbox"."message" -> 'facilityId') is not distinct from 'string'
            and "outbox"."message" ->> 'facilityId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          )
        )
        and ("outbox"."message" ->> 'createdAt')::timestamptz is not distinct from "outbox"."created_at"
        and "outbox"."message" -> 'authorization' is not distinct from "outbox"."authorization"
        and "outbox"."message" -> 'channels' is not distinct from "outbox"."channels");--> statement-breakpoint
-- No CASCADE. Every constraint that depended on these two tables is dropped by
-- name above, so anything still holding a reference here is something this
-- migration did not account for and the drop should fail rather than remove it.
-- Targets first: they are the only remaining reference to the configurations.
DROP TABLE "audience_targets";--> statement-breakpoint
DROP TABLE "audience_configurations";--> statement-breakpoint
DROP TYPE "public"."audience_target_kind";--> statement-breakpoint
ALTER TABLE "agent_api_key_grants" ALTER COLUMN "capability_id" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."agent_capability_grant";--> statement-breakpoint
CREATE TYPE "public"."agent_capability_grant" AS ENUM('sync-roster', 'prepare-activation', 'start-event', 'join-event', 'all-clear-event', 'reactivate-event', 'close-event', 'reopen-as-correction', 'append-journal-entry', 'correct-journal-entry', 'redact-journal-entry', 'create-media-upload-intent', 'complete-media-upload', 'create-event-type-draft', 'update-event-type-draft', 'publish-event-type-version', 'create-facility', 'update-facility', 'create-neighborhood-version', 'create-group-source', 'update-group-source', 'set-channel-enabled', 'create-activation-preview', 'create-lifecycle-consequence-preview', 'get-prepared-activation', 'get-roster-snapshot', 'list-group-sources', 'get-roster-health', 'get-stale-roster-report', 'list-active-events', 'get-event', 'list-journal-entries', 'search-journal-entries', 'get-media-read-grant', 'list-event-types', 'get-event-type-version', 'get-event-type-draft', 'preview-event-type-rendering', 'get-notification-status', 'run-delivery-report', 'list-delivery-test-reports', 'get-integration-health', 'list-facilities', 'get-facility', 'list-neighborhoods', 'list-neighborhood-versions', 'get-neighborhood-version', 'list-users', 'list-agent-api-keys', 'list-drill-records', 'export-drill-records', 'export-event-summary', 'query-security-audit', 'verify-security-audit-chain');--> statement-breakpoint
ALTER TABLE "agent_api_key_grants" ALTER COLUMN "capability_id" SET DATA TYPE "public"."agent_capability_grant" USING "capability_id"::"public"."agent_capability_grant";--> statement-breakpoint
ALTER TABLE "human_confirmation_records" ALTER COLUMN "capability_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "idempotency_records" ALTER COLUMN "capability_id" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."mutation_capability";--> statement-breakpoint
CREATE TYPE "public"."mutation_capability" AS ENUM('complete-oidc-sign-in', 'refresh-session', 'revoke-session', 'sync-roster', 'sync-access-membership', 'record-delivery-test-canary-eligibility', 'create-delivery-test-target-set-version', 'prepare-activation', 'start-event', 'join-event', 'append-journal-entry', 'correct-journal-entry', 'redact-journal-entry', 'all-clear-event', 'reactivate-event', 'close-event', 'reopen-as-correction', 'create-media-upload-intent', 'complete-media-upload', 'create-event-type-draft', 'update-event-type-draft', 'publish-event-type-version', 'dispatch-outbox', 'record-delivery-evidence', 'reconcile-delivery-attempts', 'record-endpoint-status', 'record-sms-opt-out', 'finalize-delivery-test-report', 'register-push-token', 'unregister-push-token', 'create-facility', 'update-facility', 'create-neighborhood-version', 'create-group-source', 'update-group-source', 'set-channel-enabled', 'issue-agent-api-key', 'revoke-agent-api-key', 'create-lifecycle-consequence-preview');--> statement-breakpoint
ALTER TABLE "human_confirmation_records" ALTER COLUMN "capability_id" SET DATA TYPE "public"."mutation_capability" USING "capability_id"::"public"."mutation_capability";--> statement-breakpoint
ALTER TABLE "idempotency_records" ALTER COLUMN "capability_id" SET DATA TYPE "public"."mutation_capability" USING "capability_id"::"public"."mutation_capability";--> statement-breakpoint
-- Nothing may still name the retired layer.
DO $$
DECLARE
	leftover integer;
BEGIN
	SELECT count(*)::integer INTO leftover
	FROM pg_catalog.pg_attribute AS column_row
	JOIN pg_catalog.pg_class AS relation ON relation.oid = column_row.attrelid
	JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
	WHERE namespace.nspname = 'public'
		AND relation.relkind = 'r'
		AND column_row.attnum > 0
		AND NOT column_row.attisdropped
		AND column_row.attname IN ('audience_config_id', 'audience_config_version');
	IF leftover <> 0 THEN
		RAISE EXCEPTION '% audience column(s) survived the retirement', leftover
			USING ERRCODE = '55000';
	END IF;

	SELECT count(*)::integer INTO leftover
	FROM pg_catalog.pg_class AS relation
	JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
	WHERE namespace.nspname = 'public'
		AND relation.relname IN ('audience_configurations', 'audience_targets');
	IF leftover <> 0 THEN
		RAISE EXCEPTION '% audience relation(s) survived the retirement', leftover
			USING ERRCODE = '55000';
	END IF;

	SELECT count(*)::integer INTO leftover
	FROM pg_catalog.pg_constraint AS constraint_row
	WHERE pg_catalog.pg_get_constraintdef(constraint_row.oid) ILIKE '%audience%'
		OR constraint_row.conname ILIKE '%audience%';
	IF leftover <> 0 THEN
		RAISE EXCEPTION '% constraint(s) still name the audience layer', leftover
			USING ERRCODE = '55000';
	END IF;

	-- The two guard functions the audience tables used are shared with
	-- neighborhood versioning, so they stay; only the triggers went.
	SELECT count(*)::integer INTO leftover
	FROM pg_catalog.pg_proc AS routine
	JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
	WHERE namespace.nspname = 'public'
		AND routine.proname IN (
			'psd_eoc_guard_admin_version_parent_insert',
			'psd_eoc_guard_admin_version_child_insert'
		);
	IF leftover <> 2 THEN
		RAISE EXCEPTION 'Admin version guards are missing; neighborhoods still need them'
			USING ERRCODE = '55000';
	END IF;
END;
$$;
