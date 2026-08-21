-- Renames `access_group_members` to `group_members`, because the row was never
-- specific to access.
--
-- The table holds `(group_source_id, email, captured_at)` and nothing else. It
-- has no access-specific column, and `group_sources` already carries a
-- `purpose` — 'access' for the groups that decide who may sign in, 'building'
-- for the groups that hold the staff at a school. The same membership fact
-- serves both, so it belongs in one table under a name that does not claim
-- otherwise.
--
-- Notification recipients will read the 'building' rows. Today they come from a
-- separate roster pipeline that snapshots the same people into
-- `roster_recipients` and `roster_endpoints`, restating `users` and
-- `device_enrollments` and adding a `phone_number` column the sync never
-- populates. That pipeline goes in a later change; this only makes the table
-- it collapses into honestly named.
--
-- Sharing the table cannot leak access. `decide_access` selects the active
-- sources where `purpose = 'access'` first, then constrains the membership
-- lookup to exactly those `group_source_id`s. A building-group row can never
-- satisfy it, and the same discipline binds every other reader.
--
-- This is a rename, not a recreate: the rows, the primary key, the foreign key,
-- and the index all survive. On a deployment with membership already published
-- nobody is signed out, and no sync has to run before the next sign-in.

ALTER TABLE "access_group_members" RENAME TO "group_members";--> statement-breakpoint
ALTER TABLE "group_members" DROP CONSTRAINT "access_group_members_group_source_id_group_sources_id_fk";
--> statement-breakpoint
DROP INDEX "access_group_members_email_idx";--> statement-breakpoint
ALTER TABLE "group_members" DROP CONSTRAINT "access_group_members_pk";--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_pk" PRIMARY KEY("group_source_id","email");--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_source_id_group_sources_id_fk" FOREIGN KEY ("group_source_id") REFERENCES "public"."group_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_members_email_idx" ON "group_members" USING btree ("email");