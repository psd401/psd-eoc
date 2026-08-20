-- Reconciles two ways the database had drifted from the schema.
--
-- The snapshot chain had been broken since 0014, so `db:generate` was diffing
-- against a five-month-old picture of the schema and could not see any of this.
-- With the chain repaired it reports three differences. Two of them are here.
--
-- The third is `mutation_capability`, which still offers `set-user-roles` and
-- `set-fanout-control` after both capabilities were retired. Removing an enum
-- value in PostgreSQL means rebuilding the type, and the rebuild rejects any row
-- still holding a retired value. One retained idempotency record holds
-- `set-fanout-control`. Deleting it is a retention decision rather than a schema
-- one, so it is deliberately not made here; the snapshot records the two values
-- the database actually has.
--
-- Neither change here alters what the product does.

-- 1. The fan-out insert function outlived the gate it belonged to.
--
-- 0023 removed the fan-out control gate and tried to drop this with it, but
-- named eighteen argument types where the function has nineteen — it takes a
-- second trailing timestamptz. `IF EXISTS` turned that miss into a no-op, so the
-- function survived a migration whose entire purpose was to remove it, and it is
-- still callable with the table it reads already gone.
--
-- Dropped by identity rather than by a written-out signature, so this cannot
-- fail the same way twice, and so a deployment that never had it is unaffected.
DO $$
DECLARE
	doomed regprocedure;
BEGIN
	FOR doomed IN
		SELECT p.oid::regprocedure
		FROM pg_catalog.pg_proc AS p
		JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
		WHERE n.nspname = 'public'
			AND p.proname = 'psd_eoc_insert_authorized_notification_intent'
	LOOP
		EXECUTE pg_catalog.format('DROP FUNCTION %s', doomed);
	END LOOP;
END;
$$;--> statement-breakpoint

-- 2. The trusted-group membership foreign key carries PostgreSQL's name.
--
-- 0017 created `access_group_members` with an inline `REFERENCES` clause and no
-- constraint name, so PostgreSQL derived `..._fkey`. Everywhere else in this
-- schema the name is Drizzle's `..._fk`, which is what `db/schema.ts` declares
-- and what a generated migration would expect to find if it ever had to touch
-- this constraint. Left alone, the next migration that did would fail on a
-- constraint name that is not there.
ALTER TABLE "access_group_members"
	DROP CONSTRAINT "access_group_members_group_source_id_fkey";--> statement-breakpoint
ALTER TABLE "access_group_members"
	ADD CONSTRAINT "access_group_members_group_source_id_group_sources_id_fk"
	FOREIGN KEY ("group_source_id") REFERENCES "public"."group_sources"("id")
	ON DELETE cascade ON UPDATE no action;
