-- Drops the access-membership evidence tables.
--
-- These held one published "generation" of who was in which trusted group: the
-- groups a snapshot expected and completed, its member rows, each member's group
-- provenance and facilities, and the normalized evaluated emails. Sign-in used
-- to re-derive its answer from all of it on every request.
--
-- Nothing reads them. Authorization asks `access_group_members` about the
-- present, bounded by how recently the sync read it, so there is no generation
-- to agree on and no baseline for a configuration change to contradict.
--
-- `access_membership_snapshots` stays: the sync still writes one row per run,
-- which is the record an operator reads to see when membership was last read and
-- the anchor an idempotent replay resolves against. `sessions.membership_snapshot_id`
-- also stays, and is no longer written — sessions issued before the cutover still
-- carry the generation they were pinned to.
drop table if exists "access_membership_member_facilities";
--> statement-breakpoint
drop table if exists "access_membership_member_groups";
--> statement-breakpoint
drop table if exists "access_membership_members";
--> statement-breakpoint
drop table if exists "access_membership_evaluated_members";
--> statement-breakpoint
drop table if exists "access_membership_snapshot_groups";

--> statement-breakpoint
-- The snapshot immutability guard named every child relation it protected, so
-- it referenced tables that no longer exist and made the sync-run record itself
-- unwritable. Redefined for the one table that remains.
create or replace function psd_eoc_reject_access_snapshot_update()
returns trigger
language plpgsql
set search_path to 'pg_catalog'
as $function$
BEGIN
	IF TG_TABLE_SCHEMA <> 'public'
		OR TG_WHEN <> 'BEFORE'
		OR TG_LEVEL <> 'ROW'
		OR TG_OP <> 'UPDATE'
	THEN
		RAISE EXCEPTION 'Unexpected access-snapshot update trigger context'
			USING ERRCODE = '55000';
	END IF;

	IF NOT (
		TG_TABLE_NAME = 'access_membership_snapshots'
			AND TG_RELID = 'public.access_membership_snapshots'::pg_catalog.regclass
	) THEN
		RAISE EXCEPTION 'Unexpected access-snapshot update trigger relation'
			USING ERRCODE = '55000';
	END IF;

	RAISE EXCEPTION 'Published access snapshot evidence is immutable on %', TG_TABLE_NAME
		USING ERRCODE = '55000';
END;
$function$;
--> statement-breakpoint
-- These guarded only the dropped children.
drop function if exists psd_eoc_guard_access_snapshot_child_insert();
--> statement-breakpoint
drop function if exists psd_eoc_reject_access_evaluated_member_update();
--> statement-breakpoint
drop function if exists psd_eoc_guard_access_evaluated_member_insert();
