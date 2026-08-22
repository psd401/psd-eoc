-- Removes the blanket DELETE ban.
--
-- Migration 0000 attached psd_eoc_reject_delete() to *every* table in the
-- public schema by looping over pg_tables, so no row anywhere could ever be
-- removed. That was never scoped to the records worth retaining: it covered
-- configuration and working data — group_sources, facilities, idempotency
-- records, session state — as readily as the incident trail.
--
-- On 2026-08-21 it helped strand a production deployment. An access group was
-- seeded with a Cloud Identity locator the membership sync could never match.
-- The locator could not be corrected, because provider locators are immutable.
-- The row could not be removed, because of this trigger. And the initial-group
-- bootstrap refused to seed a replacement while any row existed. The result
-- was a live deployment nobody could sign in to, recoverable only by changing
-- application code and redeploying during the outage.
--
-- The targeted immutability triggers stay. Those are specific and defensible:
-- a published neighborhood version cannot gain a facility after the fact, a
-- provider locator cannot be repointed at a different group, and evidence
-- digests, classifications, and timestamps cannot be rewritten. They protect
-- the record an emergency notification platform has to be able to defend
-- afterward, and they do it per-column and per-table rather than by banning an
-- entire SQL statement everywhere.
DO $$
DECLARE
	guard record;
BEGIN
	FOR guard IN
		SELECT c.relname AS table_name, t.tgname AS trigger_name
		FROM pg_catalog.pg_trigger t
		JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
		JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
		JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
		WHERE n.nspname = 'public'
		  AND NOT t.tgisinternal
		  AND p.proname = 'psd_eoc_reject_delete'
	LOOP
		EXECUTE format(
			'DROP TRIGGER IF EXISTS %I ON public.%I',
			guard.trigger_name, guard.table_name
		);
	END LOOP;
END;
$$;--> statement-breakpoint

DROP FUNCTION IF EXISTS psd_eoc_reject_delete();
