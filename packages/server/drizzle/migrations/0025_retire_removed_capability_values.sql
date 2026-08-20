-- Removes two capabilities from `mutation_capability` that no longer exist.
--
-- `set-user-roles` went when roles stopped being stored and started being
-- derived from group membership on every request; there is no supported way to
-- make somebody an administrator except by putting them in a group that grants
-- it, so a capability that writes roles directly cannot be honoured.
-- `set-fanout-control` went with the fan-out gate in 0023. Neither is in the
-- capability manifest, so nothing can invoke either one, but the type still
-- advertises both as legal values and `db/schema.ts` no longer does.
--
-- PostgreSQL has no `ALTER TYPE ... DROP VALUE`, so the type is rebuilt: the two
-- columns that use it go out to text, the type is replaced, and they come back.
-- Nothing else depends on it — no views, no defaults, and the unique constraint
-- over `idempotency_records` is rebuilt by PostgreSQL with the column.
--
-- The cast back rejects any row still holding a retired value. On the live
-- database there is exactly one: a completed idempotency record from
-- 2026-08-18, the single time anyone used the fan-out switch. An idempotency
-- record exists so a request cannot be replayed; a request whose capability no
-- longer exists cannot be replayed by anything, so the row guards nothing. What
-- the district did that day is recorded in `security_audit_entries`, which this
-- does not touch — the audit trail of the action survives, only the
-- replay-protection row goes.
--
-- These tables carry `_retain_guard`, which refuses DELETE outright, so the
-- guards come off and go back on around a bounded deletion. That is the pattern
-- 0012 established for the synthetic facility purge, and it is followed here for
-- the same reason: the guard is the rule, and suspending it has to be visible,
-- counted, and proven to have been restored. A deployment with no such rows
-- deletes nothing and every assertion still holds.

DO $$
DECLARE
	guarded_tables constant text[] := ARRAY['idempotency_records', 'human_confirmation_records'];
	retired_values constant text[] := ARRAY['set-user-roles', 'set-fanout-control'];
	table_name text;
	guard_count integer;
	retired_before integer;
	total_before integer;
	total_after integer;
	deleted_count integer;
	survivor_digest_before text;
	survivor_digest_after text;
BEGIN
	FOREACH table_name IN ARRAY guarded_tables LOOP
		-- Refuse to proceed unless the guard is present, enabled, and is the
		-- retention guard rather than something that merely shares its name.
		SELECT count(*)::integer INTO guard_count
		FROM pg_catalog.pg_trigger AS trigger
		JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
		JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		WHERE namespace.nspname = 'public'
			AND relation.relname = table_name
			AND trigger.tgname = table_name || '_retain_guard'
			AND trigger.tgenabled = 'O'
			AND trigger.tgtype = 11
			AND trigger.tgfoid = 'public.psd_eoc_reject_delete()'::pg_catalog.regprocedure
			AND NOT trigger.tgisinternal;
		IF guard_count <> 1 THEN
			RAISE EXCEPTION 'Retain guard is absent or disabled on %', table_name
				USING ERRCODE = '55000';
		END IF;
	END LOOP;

	-- Everything that is not being deleted must survive byte for byte.
	SELECT count(*)::integer INTO total_before FROM public."idempotency_records";
	SELECT count(*)::integer INTO retired_before
	FROM public."idempotency_records" WHERE "capability_id"::text = ANY(retired_values);
	SELECT pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(to_jsonb(idempotency_row) ORDER BY idempotency_row."id")::text, 'null'))
	INTO survivor_digest_before
	FROM public."idempotency_records" AS idempotency_row
	WHERE idempotency_row."capability_id"::text <> ALL(retired_values);

	FOREACH table_name IN ARRAY guarded_tables LOOP
		EXECUTE pg_catalog.format('DROP TRIGGER %I ON public.%I', table_name || '_retain_guard', table_name);
	END LOOP;

	DELETE FROM public."idempotency_records" WHERE "capability_id"::text = ANY(retired_values);
	GET DIAGNOSTICS deleted_count = ROW_COUNT;
	IF deleted_count <> retired_before THEN
		RAISE EXCEPTION 'Retired-capability purge deleted % idempotency rows instead of %', deleted_count, retired_before
			USING ERRCODE = '55000';
	END IF;

	-- Empty on every deployment seen so far, but a confirmation is single-use and
	-- short-lived, so a retired value here would block the cast just the same.
	DELETE FROM public."human_confirmation_records" WHERE "capability_id"::text = ANY(retired_values);

	FOREACH table_name IN ARRAY guarded_tables LOOP
		EXECUTE pg_catalog.format(
			'CREATE TRIGGER %I BEFORE DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.psd_eoc_reject_delete()',
			table_name || '_retain_guard', table_name
		);
		SELECT count(*)::integer INTO guard_count
		FROM pg_catalog.pg_trigger AS trigger
		JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
		JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		WHERE namespace.nspname = 'public'
			AND relation.relname = table_name
			AND trigger.tgname = table_name || '_retain_guard'
			AND trigger.tgenabled = 'O'
			AND trigger.tgtype = 11
			AND trigger.tgfoid = 'public.psd_eoc_reject_delete()'::pg_catalog.regprocedure
			AND NOT trigger.tgisinternal;
		IF guard_count <> 1 THEN
			RAISE EXCEPTION 'Retain guard was not restored exactly on %', table_name
				USING ERRCODE = '55000';
		END IF;
	END LOOP;

	SELECT count(*)::integer INTO total_after FROM public."idempotency_records";
	IF total_after <> total_before - retired_before THEN
		RAISE EXCEPTION 'Idempotency record count is % after the purge, expected %', total_after, total_before - retired_before
			USING ERRCODE = '55000';
	END IF;

	SELECT pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(to_jsonb(idempotency_row) ORDER BY idempotency_row."id")::text, 'null'))
	INTO survivor_digest_after FROM public."idempotency_records" AS idempotency_row;
	IF survivor_digest_after IS DISTINCT FROM survivor_digest_before THEN
		RAISE EXCEPTION 'Idempotency records other than the retired-capability rows changed'
			USING ERRCODE = '55000';
	END IF;

	RAISE NOTICE 'Retired-capability purge removed % idempotency row(s)', deleted_count;
END;
$$;--> statement-breakpoint

ALTER TABLE "human_confirmation_records" ALTER COLUMN "capability_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "idempotency_records" ALTER COLUMN "capability_id" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."mutation_capability";--> statement-breakpoint
CREATE TYPE "public"."mutation_capability" AS ENUM('complete-oidc-sign-in', 'refresh-session', 'revoke-session', 'sync-roster', 'sync-access-membership', 'record-delivery-test-canary-eligibility', 'create-delivery-test-target-set-version', 'prepare-activation', 'start-event', 'join-event', 'append-journal-entry', 'correct-journal-entry', 'redact-journal-entry', 'all-clear-event', 'reactivate-event', 'close-event', 'reopen-as-correction', 'create-media-upload-intent', 'complete-media-upload', 'create-event-type-draft', 'update-event-type-draft', 'publish-event-type-version', 'dispatch-outbox', 'record-delivery-evidence', 'reconcile-delivery-attempts', 'record-endpoint-status', 'record-sms-opt-out', 'finalize-delivery-test-report', 'register-push-token', 'unregister-push-token', 'create-facility', 'update-facility', 'create-neighborhood-version', 'create-audience-config-version', 'create-group-source', 'update-group-source', 'set-channel-enabled', 'issue-agent-api-key', 'revoke-agent-api-key', 'create-lifecycle-consequence-preview');--> statement-breakpoint
ALTER TABLE "human_confirmation_records" ALTER COLUMN "capability_id" SET DATA TYPE "public"."mutation_capability" USING "capability_id"::"public"."mutation_capability";--> statement-breakpoint
ALTER TABLE "idempotency_records" ALTER COLUMN "capability_id" SET DATA TYPE "public"."mutation_capability" USING "capability_id"::"public"."mutation_capability";
